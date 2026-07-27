import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { exists, readJsonIfExists, readText, readTextIfExists, sha256File, writeFileAtomic, writeJsonAtomic, ensureDir } from '../core/fsx.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { phasePaths, type PhasePaths } from '../core/paths.js';
import { readState } from '../core/state.js';
import { touchManifest, canonicalBaselineHash } from '../core/manifest.js';
import { activeMilestone, type MilestoneRef } from '../core/milestones.js';
import { readRequirements, readRoadmap, writeRoadmap, nextPhase, type RoadmapDoc } from '../core/roadmap.js';
import { readPlan, writePlan, lintPlan, setTaskStatus, parallelGroups } from '../core/plan.js';
import { validateStateIntegrity } from '../core/traceability.js';
import { checkContextBudget } from '../core/contextBudget.js';
import { snapshotFiles, diffSnapshots, pathInScope, type FileSnapshot } from '../core/scope.js';
import {
  AttemptWorkspace,
  snapshotTree,
  diffTrees,
  findEscapingSymlinks,
  WorkspaceScopeError,
  CanonicalWriteError,
  SymlinkEscapeError,
  PatchConflictError,
} from '../core/workspace.js';
import { redact } from '../security/redact.js';
import { PhasePlanDraftSchema, PhasePlanSchema, ReviewFindingTypeSchema, FindingSeveritySchema, looseBool, type RoadmapPhase, type PhasePlan, type TaskStatus } from '../core/schemas/index.js';
import type { CommandEvidence } from '../core/commands.js';
import type { AgentTask, AgentTaskDraft, AgentResult } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  dispatch,
  dispatchBatch,
  guardSchema,
  replaceableAttempt,
  dispatchReadOnly,
  commitDecisionProposals,
  discardDecisionProposals,
  durableCheckpoint,
  isNativeResultRequired,
  isWorkflowCancellation,
  type ReplaceableAttempt,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
  type ValidatedAgentEnvelope,
} from './shared.js';
import { checkCore } from './check.js';
import { inferSecurityTag, inferHighRisk } from './routing.js';
import { stageFinalization } from './finalize.js';
import { syncActiveProjectProjections } from './projections.js';
import {
  buildContextPacket,
  gapsAffectingScope,
  structuredGapsAffectingScope,
  validatePlanMapReferences,
} from '../codebase/context.js';
import { readMapState } from '../codebase/state.js';
import { ensureCodebaseMap } from './map.js';

export interface RunOptions {
  /** undefined = resume from STATE.md; 'next' = next ready phase; 'all' = every phase; 'NN' = specific phase */
  target?: string;
  /** Explicit programmatic opt-in/out for the same-lock production --fix gate. */
  finalCheck?: boolean;
}

const ReviewPayloadSchema = z.object({
  approved: looseBool(false),
  findings: z
    .array(
      z.object({
        type: ReviewFindingTypeSchema,
        severity: FindingSeveritySchema.default('medium'),
        description: z.string(),
        file: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

export function normalizeResearchCheckedAt(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

const PhaseResearchPayloadSchema = z.object({
  summary: z.string().min(1),
  volatile_facts: looseBool(true),
  sources: z
    .array(
      z.object({
        claim: z.string().min(1),
        source: z.string().min(1),
        url: z.string().url(),
        checked_at: z.string().transform(normalizeResearchCheckedAt).pipe(z.string().datetime()),
        version: z.string().min(1),
        tier: z.literal('official'),
      }),
    )
    .default([]),
});

const PhaseRecoveryBaselineSchema = z.object({
  snapshot: z.array(z.tuple([z.string(), z.string()])),
  controlled_snapshot: z.array(z.tuple([z.string(), z.string()])),
  dirty_at_start: z.array(z.string()),
});

const PlanInvalidationSchema = z.object({
  schema_version: z.literal(1),
  milestone: z.string(),
  phase: z.string(),
  plan_path: z.string(),
  status: z.enum(['INVALIDATED', 'REPLANNED']),
  reasons: z.array(z.string()).min(1),
  old_plan_hash: z.string().nullable(),
  new_plan_hash: z.string().nullable(),
  invalidated_at: z.string().datetime(),
  replanned_at: z.string().datetime().nullable(),
});

function planInvalidationPath(ctx: WorkflowContext, milestone: string, phase: string): string {
  return path.join(ctx.paths.runtimeDir, 'plan-invalidations', `${milestone}-${phase}.json`);
}

function writePlanInvalidation(
  ctx: WorkflowContext,
  milestone: string,
  phase: string,
  planPath: string,
  reasons: string[],
): void {
  writeJsonAtomic(
    planInvalidationPath(ctx, milestone, phase),
    PlanInvalidationSchema.parse({
      schema_version: 1,
      milestone,
      phase,
      plan_path: path.relative(ctx.projectRoot, planPath).split(path.sep).join('/'),
      status: 'INVALIDATED',
      reasons,
      old_plan_hash: exists(planPath) ? sha256File(planPath) : null,
      new_plan_hash: null,
      invalidated_at: ctx.now().toISOString(),
      replanned_at: null,
    }),
  );
  ctx.planHooks.afterInvalidated?.();
}

function markPlanReplanned(
  ctx: WorkflowContext,
  milestone: string,
  phase: string,
  planPath: string,
): void {
  const target = planInvalidationPath(ctx, milestone, phase);
  const marker = PlanInvalidationSchema.safeParse(readJsonIfExists<unknown>(target));
  if (!marker.success || marker.data.status !== 'INVALIDATED') return;
  writeJsonAtomic(target, {
    ...marker.data,
    status: 'REPLANNED',
    new_plan_hash: sha256File(planPath),
    replanned_at: ctx.now().toISOString(),
  });
  ctx.planHooks.afterReplanned?.();
}

function phaseRecoveryBaselinePath(ctx: WorkflowContext, milestone: string, phase: string): string {
  return path.join(ctx.paths.runtimeDir, 'phase-baselines', `${milestone}-${phase}.json`);
}

function writePhaseRecoveryBaseline(
  target: string,
  snapshot: FileSnapshot,
  dirtyAtStart: Set<string>,
  controlledSnapshot: FileSnapshot,
): void {
  writeFileAtomic(
    target,
    `${JSON.stringify(
      {
        snapshot: [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right)),
        controlled_snapshot: [...controlledSnapshot.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        dirty_at_start: [...dirtyAtStart].sort(),
      },
      null,
      2,
    )}\n`,
  );
}

export function readPhaseExecutionBaseline(
  target: string,
): { snapshot: FileSnapshot; controlledSnapshot: FileSnapshot; dirtyAtStart: Set<string> } | null {
  const raw = readTextIfExists(target);
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PhaseRecoveryBaselineSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    snapshot: new Map(parsed.data.snapshot),
    controlledSnapshot: new Map(parsed.data.controlled_snapshot),
    dirtyAtStart: new Set(parsed.data.dirty_at_start),
  };
}

const UiSmokePayloadSchema = z.object({
  passed: looseBool(false),
  console_errors: z.array(z.string()).default([]),
  network_errors: z.array(z.string()).default([]),
  screenshot: z.string().nullable().default(null),
  notes: z.string().default(''),
});

export async function runWorkflow(
  projectRoot: string,
  opts: RunOptions = {},
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  if (!exists(ctx.paths.manifest)) {
    return failed(ctx, 'No RIJO project here. Run `rijo new @PLAN.md` first.');
  }
  const autonomous = Boolean(ctx.durable) && (opts.finalCheck ?? (opts.target === undefined || opts.target === 'all'));
  return withLock(ctx, () => runCore(ctx, opts), {
    terminal: autonomous,
  });
}

/** Native public implementation route. Full product QA remains a separate step. */
export async function startWorkflow(
  projectRoot: string,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  return runWorkflow(projectRoot, { target: 'all', finalCheck: false }, deps);
}

/**
 * Run the phase state machine using an EXISTING context and lock. This is what
 * `rijo new --run` composes with, so the run does not try to re-acquire a lock
 * the enclosing `new` already holds.
 */
export async function runCore(ctx: WorkflowContext, opts: RunOptions = {}): Promise<WorkflowOutcome> {
  const { paths, bus } = ctx;
  const autonomous = Boolean(ctx.durable) && (opts.finalCheck ?? (opts.target === undefined || opts.target === 'all'));
  {
    // ---- LOAD
    bus.emit('run.phase_load', {
      status: 'running',
      stage: 'PHASE_LOAD',
      message: '[RIJO] PHASE_LOAD',
    });
    const schemaGuard = guardSchema(ctx);
    if (schemaGuard) return schemaGuard;
    // Orphan-workspace discard and crash recovery already ran in withLock (which
    // also wraps `rijo new --run` composing runCore), so LOAD does not repeat it.
    const integrity = validateStateIntegrity(paths);
    const errors = integrity.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return blocked(ctx, 'State integrity check failed.', errors.map((e) => `${e.code}: ${e.message} — ${e.fix}`));
    }
    // Per-attempt isolation is only real if the project can be copied without
    // carrying a door out of it: a symlink whose target escapes the checkout
    // would let an attempt read and write the host filesystem. Workspace
    // creation refuses such a project anyway — reporting it here turns the
    // refusal into a BLOCKED outcome with guidance instead of an exception.
    const escaping = findEscapingSymlinks(ctx.projectRoot);
    if (escaping.length > 0) {
      return blocked(
        ctx,
        `The checkout contains symlinks whose target is absolute or leaves the project root: ${escaping.join(', ')}. ` +
          `An attempt workspace cannot isolate them.`,
        ['Remove the links or repoint them at a relative path inside the project, then re-run.'],
      );
    }
    const milestone = activeMilestone(paths);
    if (!milestone) return failed(ctx, 'No active milestone in manifest.');
    if (!exists(milestone.paths.roadmap)) return failed(ctx, `Missing ROADMAP.md for ${milestone.id}.`);

    const budget = checkContextBudget(
      [paths.rules, paths.state, milestone.paths.requirements],
      ctx.config.context_budget_bytes,
    );
    if (!budget.withinBudget) {
      bus.emit('run.budget_warning', { message: `Automatic context ${budget.bytes}B exceeds budget ${budget.budget}B.` });
    }

    const roadmap = readRoadmap(milestone.paths.roadmap);
    const targets = resolveTargets(ctx, roadmap, autonomous ? 'all' : opts.target);
    if (targets.length === 0) {
      const allDone = roadmap.phases.every((p) => p.status === 'DONE');
      if (allDone && autonomous) return runAutonomousFinalCheck(ctx);
      if (allDone) {
        syncActiveProjectProjections(paths);
        bus.emit('run.implementation_complete', {
          status: 'completed',
          stage: 'IMPLEMENTATION_COMPLETE',
          milestone: { id: milestone.id, name: milestone.slug },
          message: `[RIJO ${milestone.id}] IMPLEMENTATION_COMPLETE`,
        });
      }
      return completed(
        ctx,
        allDone ? `All ${roadmap.phases.length} phases of ${milestone.id} are DONE.` : 'No ready phase (check dependencies/blockers).',
      );
    }

    for (const phase of targets) {
      const outcome = await executePhase(ctx, milestone, phase);
      if (!outcome.ok) return outcome;
      await durableCheckpoint(ctx, `phase:${phase.id}:completed`, {
        commit: ctx.git.headCommit(ctx.projectRoot),
      });
      syncActiveProjectProjections(paths);
      if (!autonomous && opts.target !== 'all') return outcome;
    }
    if (autonomous) return runAutonomousFinalCheck(ctx);
    bus.emit('run.implementation_complete', {
      status: 'completed',
      stage: 'IMPLEMENTATION_COMPLETE',
      milestone: { id: milestone.id, name: milestone.slug },
      message: `[RIJO ${milestone.id}] IMPLEMENTATION_COMPLETE`,
    });
    return completed(ctx, `Completed ${targets.length} phase(s) of ${milestone.id}.`);
  }
}

async function runAutonomousFinalCheck(ctx: WorkflowContext): Promise<WorkflowOutcome> {
  ctx.bus.emit('run.final_check', {
    status: 'running',
    stage: 'CHECKS',
    message: 'All phases are complete. Run the bounded production check.',
  });
  await durableCheckpoint(ctx, 'run:before-final-check', {
    commit: ctx.git.headCommit(ctx.projectRoot),
  });
  const check = ctx.finalCheck ?? checkCore;
  return check(ctx, { production: true, fix: true });
}

function nativePhaseStage(
  stage: import('../core/schemas/index.js').Stage,
): import('../core/schemas/index.js').Stage {
  switch (stage) {
    case 'LOAD':
      return 'PHASE_LOAD';
    case 'RESEARCH_DELTA':
    case 'SPEC_READY':
      return 'PHASE_RESEARCH';
    case 'PLAN':
    case 'PLAN_LINT':
      return 'PHASE_PLAN';
    case 'CODE_REVIEW':
      return 'ENGINEERING_REVIEW';
    case 'UI_SMOKE':
      return 'VERIFY';
    case 'PERSIST':
    case 'COMMIT':
    case 'DONE':
      return 'PHASE_DONE';
    default:
      return stage;
  }
}

function resolveTargets(ctx: WorkflowContext, roadmap: RoadmapDoc, target?: string): RoadmapPhase[] {
  if (target && /^\d{2}$/.test(target)) {
    const phase = roadmap.phases.find((p) => p.id === target);
    if (!phase) throw new Error(`Phase ${target} not found in roadmap`);
    return phase.status === 'DONE' ? [] : [phase];
  }
  if (target === 'all') {
    // sequential order respecting deps: repeatedly pick next ready
    const list: RoadmapPhase[] = [];
    const sim = new Set(roadmap.phases.filter((p) => p.status === 'DONE').map((p) => p.id));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const p of roadmap.phases) {
        if (p.status === 'DONE' || sim.has(p.id) || list.includes(p)) continue;
        if (p.depends_on.every((d) => sim.has(d))) {
          list.push(p);
          sim.add(p.id);
          progressed = true;
        }
      }
    }
    return list;
  }
  // resume from STATE.md, else next ready
  const state = readState(ctx.paths);
  if (!target && state?.phase) {
    const phase = roadmap.phases.find((p) => p.id === state.phase && p.status !== 'DONE');
    if (phase) return [phase];
  }
  const np = nextPhase(roadmap);
  return np ? [np] : [];
}

async function executePhase(
  ctx: WorkflowContext,
  milestone: MilestoneRef,
  phase: RoadmapPhase,
): Promise<WorkflowOutcome> {
  const { paths, bus, config, now } = ctx;
  const roadmap = readRoadmap(milestone.paths.roadmap);
  const phaseIndex = roadmap.phases.findIndex((p) => p.id === phase.id) + 1;
  const phaseDir = path.join(milestone.paths.phasesDir, `${phase.id}-${phase.slug}`);
  ensureDir(phaseDir);
  const pp = phasePaths(phaseDir);
  const phaseInfo = { id: phase.id, index: phaseIndex, total: roadmap.phases.length, name: phase.name };
  const milestoneInfo = { id: milestone.id, name: milestone.slug };
  const stage = (s: import('../core/schemas/index.js').Stage, message: string, extra: Record<string, unknown> = {}) => {
    const publicStage = nativePhaseStage(s);
    return bus.emit(
      `run.${publicStage.toLowerCase()}`,
      {
        status: 'running',
        stage: publicStage,
        milestone: milestoneInfo,
        phase: phaseInfo,
        message: `[RIJO ${milestone.id} F${phase.id}/${String(roadmap.phases.length).padStart(2, '0')}] ${publicStage}`,
      },
      { ...extra, detail: message },
    );
  };

  const markPhase = (status: RoadmapPhase['status'], commit?: string | null) => {
    const doc = readRoadmap(milestone.paths.roadmap);
    const p = doc.phases.find((x) => x.id === phase.id)!;
    p.status = status;
    if (commit !== undefined) p.commit = commit;
    writeRoadmap(milestone.paths.roadmap, doc);
  };

  /** Append-only transition event FIRST, then the plan projection, then manifest hashes. */
  const transition = (taskId: string, to: TaskStatus, reason = '') => {
    bus.emit('task.transition', { message: `Task ${taskId} → ${to}${reason ? ` (${reason})` : ''}` }, { task: taskId, to, reason });
    setTaskStatus(pp.plan, taskId, to);
    touchManifest(paths, () => {}, now);
  };

  let forceReplan = false;
  let appliedPlanAtEntry = false;
  if (readMapState(paths)) {
    stage('LOAD', 'Check map and plan freshness before the phase starts.');
    const rawPlanData = exists(pp.plan)
      ? parseFrontmatter<Record<string, unknown>>(readText(pp.plan)).data
      : null;
    const rawTasks = Array.isArray(rawPlanData?.['tasks'])
      ? (rawPlanData!['tasks'] as Array<Record<string, unknown>>)
      : [];
    const hasAppliedProgress = rawTasks.some((task) =>
      ['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(String(task['status'] ?? 'PENDING')),
    );
    appliedPlanAtEntry = hasAppliedProgress;
    let allowedDirtyPaths = ctx.git
      .status(ctx.projectRoot)
      .dirtyFiles.filter((dirtyPath) => dirtyPath === '.rijo' || dirtyPath.startsWith('.rijo/'));
    if (hasAppliedProgress) {
      const recovery = readPhaseExecutionBaseline(
        phaseRecoveryBaselinePath(ctx, milestone.id, phase.id),
      );
      if (!recovery) {
        return blocked(ctx, `Phase ${phase.id}: source baseline needed for safe freshness recovery is missing.`, [
          'The existing plan records applied tasks, but RIJO cannot distinguish controlled work from external changes.',
        ]);
      }
      const externalDelta = diffSnapshots(recovery.controlledSnapshot, snapshotFiles(ctx.projectRoot));
      const writeScopes = rawTasks.flatMap((task) =>
        Array.isArray(task['write_scope']) ? (task['write_scope'] as string[]) : [],
      );
      const overlapping = externalDelta.changed.filter((changed) =>
        writeScopes.some((scope) => pathInScope(changed, [scope])),
      );
      if (overlapping.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: external changes overlap the existing plan.`, [
          `Conflicting paths: ${overlapping.join(', ')}`,
          'RIJO did not appropriate, overwrite, or revert these paths.',
        ]);
      }
      allowedDirtyPaths = ctx.git.status(ctx.projectRoot).dirtyFiles;
      if (externalDelta.changed.length > 0) {
        bus.emit(
          'run.external_change_non_overlapping',
          { message: `Recorded an unrelated external change for phase ${phase.id}.` },
          { phase: phase.id, paths: externalDelta.changed },
        );
      }
    }
    const ensured = await ensureCodebaseMap(ctx, {
      commit: true,
      ...(allowedDirtyPaths.length > 0 ? { allowedDirtyPaths } : {}),
    });
    if (!ensured.outcome.ok) return ensured.outcome;
    if (!ensured.state || ensured.state.status === 'BLOCKED') {
      return blocked(ctx, `Phase ${phase.id}: current codebase map is not safe for planning.`, [
        `Map status: ${ensured.state?.status ?? 'missing'}.`,
        ...(ensured.state?.gaps ?? []),
      ]);
    }
    const phaseRequirements = readRequirements(milestone.paths.requirements).requirements.filter(
      (requirement) => requirement.phase === phase.id,
    );
    const phaseScope = [
      phase.name,
      ...phaseRequirements.flatMap((requirement) => [requirement.description, requirement.acceptance]),
    ].join('\n');
    const affectingGaps =
      ensured.state.gap_records.length > 0
        ? structuredGapsAffectingScope(ensured.state.gap_records, phaseScope)
        : gapsAffectingScope(ensured.state.gaps, phaseScope);
    if (ensured.state.status === 'PARTIAL' && affectingGaps.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: codebase map gaps intersect the phase scope.`, affectingGaps);
    }
    if (exists(pp.plan)) {
      const marker = PlanInvalidationSchema.safeParse(
        readJsonIfExists<unknown>(planInvalidationPath(ctx, milestone.id, phase.id)),
      );
      if (marker.success && marker.data.status === 'INVALIDATED') {
        forceReplan = true;
      } else {
        let existingPlan: PhasePlan | null = null;
        try {
          existingPlan = readPlan(pp.plan);
        } catch (error) {
          if (hasAppliedProgress) {
            return blocked(ctx, `Phase ${phase.id}: an applied legacy plan cannot be migrated safely.`, [
              error instanceof Error ? error.message : String(error),
            ]);
          }
          writePlanInvalidation(ctx, milestone.id, phase.id, pp.plan, [
            'LEGACY_PLAN_SCHEMA: mapped references or freshness metadata are missing',
          ]);
          forceReplan = true;
        }
        if (existingPlan) {
          const packet = buildContextPacket(ctx.projectRoot, phaseScope, config.context_budget_bytes, now);
          const referenceIssues = validatePlanMapReferences(ctx.projectRoot, existingPlan).filter((issue) => {
            if (!hasAppliedProgress) return true;
            const task = existingPlan!.tasks.find((candidate) => candidate.id === issue.task_id);
            if (!task || !['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(task.status)) return true;
            return !task.write_scope.some((scope) => issue.message.includes(scope));
          });
          const declaredReferenceHashes = Object.fromEntries(
            existingPlan.tasks.flatMap((task) =>
              task.mapped_references
                .filter((reference) => reference.intent === 'existing')
                .map((reference) => [reference.path, reference.file_hash]),
            ),
          );
          const freshnessReasons = [
            ...(existingPlan.mapped_commit !== ensured.state.mapped_commit
              ? [`mapped_commit changed (${existingPlan.mapped_commit} -> ${ensured.state.mapped_commit})`]
              : []),
            ...(existingPlan.mapped_tree_hash !== ensured.state.mapped_tree_hash
              ? ['mapped_tree_hash changed']
              : []),
            ...(existingPlan.context_packet_hash !== packet.packet_hash
              ? ['context_packet_hash changed']
              : []),
            ...(existingPlan.decision_context_hash !== packet.decision_context_hash
              ? ['decision_context_hash changed']
              : []),
            ...(JSON.stringify(existingPlan.mapped_reference_hashes) !== JSON.stringify(declaredReferenceHashes)
              ? ['mapped_reference_hashes do not match the plan references']
              : []),
            ...referenceIssues.map((issue) => `${issue.code}: ${issue.message}`),
          ];
          if (freshnessReasons.length > 0) {
            const overlappingReferences = referenceIssues.filter((issue) =>
              ['MAP_HASH_MISMATCH', 'MAP_SYMBOL_NOT_FOUND', 'MAP_PATH_NOT_FOUND', 'MAP_INTENT_MISMATCH'].includes(
                issue.code,
              ),
            );
            if (hasAppliedProgress && overlappingReferences.length > 0) {
              return blocked(ctx, `Phase ${phase.id}: mapped references changed after tasks were applied.`, [
                ...overlappingReferences.map((issue) => issue.message),
                'Recovery is not deterministic; the controlled checkout was left unchanged.',
              ]);
            }
            if (!hasAppliedProgress) {
              writePlanInvalidation(ctx, milestone.id, phase.id, pp.plan, freshnessReasons);
              forceReplan = true;
            } else {
              bus.emit(
                'run.plan_freshness_reconciled',
                { message: `Reconciled the applied phase ${phase.id} plan with a non-overlapping external change.` },
                { reasons: freshnessReasons },
              );
            }
          }
        }
      }
    }
    bus.emit(
      'run.map_context_fresh',
      { message: `Phase ${phase.id} will use map ${ensured.state.mapped_commit}.` },
      {
        phase: phase.id,
        mapped_commit: ensured.state.mapped_commit,
        mapped_tree_hash: ensured.state.mapped_tree_hash,
        last_operation: ensured.state.last_operation,
        changed_paths: ensured.state.changed_paths_since_map,
      },
    );
  }

  // Record which files were ALREADY dirty before this phase ran: a phase commit
  // must never appropriate pre-existing user changes, and overlapping paths are
  // an explicit conflict rather than a silent sweep.
  const gitStatusAtStart = ctx.git.status(ctx.projectRoot);
  const initialDirtyAtStart = new Set(gitStatusAtStart.dirtyFiles);

  markPhase('IN_PROGRESS');
  touchManifest(paths, () => {}, now);

  // ---- PHASE_RESEARCH (bounded, read-only, persisted by the deterministic core)
  stage('RESEARCH_DELTA', 'Research the current phase delta.');
  if (!exists(pp.research)) {
    const reqDoc = readRequirements(milestone.paths.requirements);
    const phaseReqs = reqDoc.requirements.filter((requirement) => requirement.phase === phase.id);
    let researchPayload: z.infer<typeof PhaseResearchPayloadSchema> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const researchTask: AgentTaskDraft = {
        id: `new-research-phase-${phase.id}-r${attempt}`,
        role: 'researcher',
        objective:
          `Research only the implementation delta for phase ${phase.id} (${phase.name}). ` +
          'Use official primary documentation for volatile facts. Do not modify the checkout.',
        canonical_files: [
          paths.rules,
          milestone.paths.scope,
          milestone.paths.requirements,
          milestone.paths.research,
        ].filter(exists),
        code_files: [],
        write_scope: [],
        acceptance_criteria: [
          'Limit research to the active phase.',
          'Provide an official source for every volatile fact.',
          'Record each source claim, URL, checked date, and version.',
        ],
        verification_commands: [],
        return_format:
          'JSON payload: {summary, volatile_facts, sources:[{claim,source,url,checked_at,version,tier:"official"}]}. ' +
          'Set volatile_facts=false only when the phase has no version-sensitive fact.',
        notes: phaseReqs
          .map((requirement) => `${requirement.id}: ${requirement.description}\nAcceptance: ${requirement.acceptance}`)
          .join('\n\n'),
        workspace: null,
        canonical_baseline: null,
      };
      const { result, violation } = await dispatchReadOnly(ctx, researchTask, {
        stage: 'RESEARCH_DELTA',
      });
      if (violation.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: researcher modified the checkout.`, violation);
      }
      const parsed = PhaseResearchPayloadSchema.safeParse(result.payload);
      if (
        result.ok &&
        parsed.success &&
        (!parsed.data.volatile_facts || parsed.data.sources.length > 0)
      ) {
        researchPayload = parsed.data;
        commitDecisionProposals(ctx, result);
        break;
      }
      discardDecisionProposals(ctx, result);
    }
    if (!researchPayload) {
      return blocked(ctx, `Phase ${phase.id}: phase research failed after 2 attempts.`, [
        'Volatile facts require an official source with a claim, URL, checked date, and version.',
      ]);
    }
    writeFileAtomic(
      pp.research,
      serializeFrontmatter(
        {
          phase: phase.id,
          researched_at: now().toISOString(),
          volatile_facts: researchPayload.volatile_facts,
          sources: researchPayload.sources,
        },
        [
          `# Phase research — ${phase.id}`,
          '',
          researchPayload.summary,
          '',
          '## Official sources',
          ...(researchPayload.sources.length
            ? researchPayload.sources.map(
                (source) =>
                  `- ${source.claim} — ${source.source} ${source.version} (${source.url}, checked ${source.checked_at})`,
              )
            : ['- No volatile facts apply to this phase.']),
          '',
        ].join('\n'),
      ),
    );
    touchManifest(paths, () => {}, now);
  }

  // ---- SPEC_READY
  if (!exists(pp.spec)) {
    stage('SPEC_READY', 'Generate the phase specification.');
    const reqDoc = readRequirements(milestone.paths.requirements);
    const phaseReqs = reqDoc.requirements.filter((r) => r.phase === phase.id);
    const specMapContext = buildContextPacket(
      ctx.projectRoot,
      [phase.name, ...phaseReqs.flatMap((requirement) => [requirement.description, requirement.acceptance])].join('\n'),
      config.context_budget_bytes,
    );
    const specRel = path.relative(ctx.projectRoot, pp.spec).split(path.sep).join('/');
    const specTask: AgentTaskDraft = {
      id: `spec-${phase.id}`,
      role: 'planner',
      objective: `Write the SPEC.md for phase ${phase.id} (${phase.name}). It must be actionable, testable, tied to real code surfaces, complete and coherent, with observable acceptance scenarios for each requirement.`,
      canonical_files: [
        paths.rules,
        milestone.paths.scope,
        milestone.paths.requirements,
        milestone.paths.research,
        pp.research,
      ].filter(exists),
      code_files: [],
      write_scope: [specRel],
      acceptance_criteria: phaseReqs.map((r) => `${r.id}: ${r.acceptance}`),
      verification_commands: [],
      return_format: 'Write SPEC.md to disk (inside your workspace); return a one-line confirmation.',
      notes: [
        `Requirements in this phase:\n${phaseReqs.map((r) => `- ${r.id}: ${r.description}`).join('\n')}`,
        specMapContext.text,
      ].join('\n\n'),
      workspace: null,
      canonical_baseline: null,
    };
    // The spec is a canonical artifact: this is an explicitly core-authorized
    // canonical write, isolated in a workspace and applied only after validation.
    const spec = replaceableAttempt(ctx, specTask, { canonicalWriteScope: [specRel] }, { stage: 'SPEC_READY' });
    const res = await dispatch(ctx, spec.attempt.task, { stage: 'SPEC_READY' }, { prepareReplacement: spec.prepareReplacement });
    try {
      if (!res.ok || !exists(path.join(spec.attempt.workspace.root, specRel))) {
        return blocked(ctx, `Phase ${phase.id}: spec generation failed.`, [res.summary]);
      }
      spec.attempt.workspace.applyVerifiedPatch();
      touchManifest(paths, () => {}, now);
      commitDecisionProposals(ctx, res);
    } catch (err) {
      return blocked(ctx, `Phase ${phase.id}: spec generation violated workspace boundaries.`, [String((err as Error).message)]);
    } finally {
      spec.attempt.workspace.discard();
    }
  } else {
    stage('SPEC_READY', 'Validated the existing specification.');
  }

  // ---- PLAN + PLAN_LINT + PLAN_REVIEW (bounded loop)
  const reqDoc = readRequirements(milestone.paths.requirements);
  const knownReqs = new Set(reqDoc.requirements.map((r) => r.id));
  const planningMapContext = buildContextPacket(
    ctx.projectRoot,
    [
      phase.name,
      ...reqDoc.requirements
        .filter((requirement) => requirement.phase === phase.id)
        .flatMap((requirement) => [requirement.description, requirement.acceptance]),
    ].join('\n'),
    config.context_budget_bytes,
  );
  const hasPlanningMap = readMapState(paths) !== null;
  let plan: PhasePlan | null = exists(pp.plan) && !forceReplan ? readPlan(pp.plan) : null;
  let revisions = 0;
  let reviewNotes: string[] = [];
  let planEnvelope: ValidatedAgentEnvelope | null = null;
  let planReviewEnvelope: ValidatedAgentEnvelope | null = null;
  while (true) {
    if (!plan) {
      stage('PLAN', `Plan tasks (revision ${revisions}).`);
      const planTask: AgentTaskDraft = {
        id: `plan-${phase.id}-r${revisions}`,
        role: 'planner',
        objective: `Produce the execution plan for phase ${phase.id}: between 2 and 4 tasks, exact files or code regions, dependencies, per-worker write scope, executable test commands and expected evidence, parallel flag only for independent tasks with disjoint write scopes. Set tdd=true for testable behavior. EVERY task must CREATE or EDIT at least one concrete source/test file — its "files" and "write_scope" arrays must each name at least one real path. Each tests[] entry must be an executable verification command such as "npm test", never a prose scenario or expected result. Do NOT emit a verification-only, evidence-only, or "run the tests" task: the framework runs verification and records evidence itself; a task that writes no file is invalid.`,
        canonical_files: [
          paths.rules,
          pp.research,
          pp.spec,
          milestone.paths.requirements,
        ].filter(exists),
        code_files: [],
        write_scope: [],
        acceptance_criteria: ['2-4 tasks', 'every task writes at least one concrete file (non-empty files[] and write_scope[])', 'every task has requirement IDs or technical justification', 'write scopes are exact'],
        verification_commands: [],
        return_format:
          'JSON payload matching PhasePlanDraft: {phase, tasks:[{id:"T01", name, requirement_ids[], technical_justification, files[/*>=1 exact path*/], mapped_references:[{path,intent:"existing",file_hash,symbol?}|{path,intent:"new",parent_module,placement_evidence:[{path,reason}]}] /* required and must cover every task file */, write_scope[/*only exact declared files*/], depends_on[], parallel, tdd, tests[/*executable command strings only, e.g. "npm test"*/], evidence_expected}]}. ' +
          (hasPlanningMap
            ? 'Existing paths must use current hashes; new paths must extend a mapped module and cite real placement evidence.'
            : 'This is a greenfield phase with no codebase map: every task file is intent:"new", parent_module:"project-root", and placement_evidence must cite package.json as the existing project-root bootstrap contract.') +
          ' Never omit mapped_references. Put behavioral scenarios in evidence_expected, not tests[].',
        notes: [
          planningMapContext.text,
          reviewNotes.length ? `Previous review issues to address:\n${reviewNotes.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        workspace: null,
        canonical_baseline: null,
      };
      const { result: res, violation } = await dispatchReadOnly(ctx, planTask, { stage: 'PLAN' });
      planEnvelope = res;
      if (violation.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: planner (read-only) modified the checkout.`, violation);
      }
      // A planner dispatch that the host could not deliver (ok:false — e.g. an
      // intermittent headless read-only glitch where the model produced no
      // parseable result) is RECOVERABLE, not fatal: re-plan within the same
      // plan_revisions budget rather than abandoning the phase on a transient
      // host blip. Only an exhausted budget blocks.
      if (!res.ok) {
        discardDecisionProposals(ctx, res);
        if (isWorkflowCancellation(res) || revisions >= config.limits.plan_revisions) {
          return blocked(ctx, `Phase ${phase.id}: planning failed after ${revisions} revisions.`, [res.summary]);
        }
        revisions++;
        reviewNotes = [
          `The previous planning attempt returned no usable plan (${res.summary.slice(0, 200)}). Return the plan ONLY as the JSON payload described in the return format — do not write any file.`,
        ];
        plan = null;
        continue;
      }
      const parsed = PhasePlanDraftSchema.safeParse(res.payload);
      if (!parsed.success) {
        discardDecisionProposals(ctx, res);
        // A schema-invalid plan (e.g. a task missing files/write_scope) is a
        // RECOVERABLE planner error, not a fatal one: feed the precise shape
        // violations back and re-plan within the same plan_revisions budget the
        // lint loop uses — a hard block here would abandon a phase on a mistake
        // the planner can trivially correct on the next turn.
        if (revisions >= config.limits.plan_revisions) {
          return blocked(ctx, `Phase ${phase.id}: planner returned an invalid plan after ${revisions} revisions.`, [
            parsed.error.message,
          ]);
        }
        revisions++;
        reviewNotes = parsed.error.issues.map(
          (i) => `Invalid plan payload at ${i.path.join('.') || '(root)'}: ${i.message}. Every task needs a non-empty files[] and write_scope[]; ids must be T01..T04; return a payload matching the PhasePlan schema exactly.`,
        );
        plan = null;
        continue;
      }
      plan = {
        ...parsed.data,
        phase: phase.id,
        mapped_commit: planningMapContext.mapped_commit || 'GREENFIELD',
        mapped_tree_hash: planningMapContext.mapped_tree_hash || 'GREENFIELD',
        planned_at: now().toISOString(),
        context_packet_hash: planningMapContext.packet_hash,
        mapped_reference_hashes: Object.fromEntries(
          parsed.data.tasks.flatMap((task) =>
            task.mapped_references
              .filter((reference) => reference.intent === 'existing')
              .map((reference) => [reference.path, reference.file_hash]),
          ),
        ),
        decision_context_hash: planningMapContext.decision_context_hash,
      };
      // The PLAN is a canonical artifact written by the CORE from the planner's
      // validated payload — the agent never touches the plan file itself.
      writePlan(pp.plan, plan, `Generated for ${phase.name}.`);
      ctx.planHooks.afterPlanWritten?.();
      markPlanReplanned(ctx, milestone.id, phase.id, pp.plan);
      touchManifest(paths, () => {}, now);
    }

    stage('PLAN_LINT', 'Validate the plan deterministically.');
    const phaseRequirements = reqDoc.requirements.filter((r) => r.phase === phase.id).map((r) => r.id);
    const lintIssues = lintPlan(plan, { knownRequirements: knownReqs, phaseRequirements });
    const mapReferenceIssues = (readMapState(paths) ? validatePlanMapReferences(ctx.projectRoot, plan) : [])
      .filter((issue) => {
        if (!appliedPlanAtEntry) return true;
        const task = plan!.tasks.find((candidate) => candidate.id === issue.task_id);
        return (
          !task ||
          !['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(task.status) ||
          !task.write_scope.some((scope) => issue.message.includes(scope))
        );
      })
      .map((issue) => ({
      code: issue.code,
      message: `${issue.task_id}: ${issue.message}`,
      fix: 'Use an existing path/symbol/hash from the current codebase map, or declare a genuinely new file below an existing directory.',
      }));
    lintIssues.push(...mapReferenceIssues);
    if (lintIssues.length > 0) {
      if (planEnvelope) discardDecisionProposals(ctx, planEnvelope);
      planEnvelope = null;
      if (revisions >= config.limits.plan_revisions) {
        return blocked(ctx, `Phase ${phase.id}: plan lint failed after ${revisions} revisions.`, lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`));
      }
      revisions++;
      reviewNotes = lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`);
      plan = null;
      continue;
    }

    stage('PLAN_REVIEW', 'Run an independent plan review.');
    const reviewTask: AgentTaskDraft = {
      id: `plan-review-${phase.id}-r${revisions}`,
      role: 'reviewer',
      objective: `Independent brief review of the phase plan: completeness, coherence, risk, requirement coverage, adherence to rules. You receive spec and plan, never the author's reasoning.`,
      canonical_files: [paths.rules, pp.spec, pp.plan].filter(exists),
      code_files: [],
      write_scope: [],
      acceptance_criteria: [],
      verification_commands: [],
      return_format:
        'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}. type MUST be exactly one of intent_gap|spec_gap|implementation_bug|test_gap|security_risk|quality_issue|defer|reject; severity MUST be blocker|critical|high|medium|low.',
      notes: '',
      workspace: null,
      canonical_baseline: null,
    };
    const { result: reviewRes, violation: reviewViolation } = await dispatchReadOnly(ctx, reviewTask, {
      stage: 'PLAN_REVIEW',
      authorProfiles: ['product-manager', 'system-architect'],
    });
    planReviewEnvelope = reviewRes;
    if (reviewViolation.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: plan reviewer (read-only) modified the checkout.`, reviewViolation);
    }
    // An ATTEMPT failure (ok:false — e.g. an intermittent headless read-only
    // glitch) is RECOVERABLE: re-run the plan/review cycle within the
    // plan_revisions budget rather than abandoning the phase on a transient blip.
    if (!reviewRes.ok) {
      discardDecisionProposals(ctx, reviewRes);
      if (isWorkflowCancellation(reviewRes) || revisions >= config.limits.plan_revisions) {
        return blocked(ctx, `Phase ${phase.id}: plan review failed to produce a verdict after ${revisions} revisions.`, [reviewRes.summary]);
      }
      revisions++;
      reviewNotes = [`The previous review returned no usable verdict (${reviewRes.summary.slice(0, 200)}).`];
      plan = null;
      continue;
    }
    const review = ReviewPayloadSchema.safeParse(reviewRes.payload);
    // Accept the plan when the reviewer approves OR (verdict parsed) raised no
    // structurally-BLOCKING finding. Only blocker/critical findings hold a plan:
    // a mere `high` nitpick (a missing dependency note, an under-specified
    // acceptance line) is routinely over-rated by the reviewer and is caught
    // anyway downstream by the deterministic lint, the verification commands and
    // the independent code review — it must not deadlock the phase. A COMPLETED
    // but unparseable verdict is treated as "revise" (never silent approval).
    // Everything is bounded by the plan_revisions budget.
    const blockingFindings = review.success
      ? review.data.findings.filter((f) => f.severity === 'blocker' || f.severity === 'critical')
      : [];
    if (review.success && (review.data.approved || blockingFindings.length === 0)) break;
    if (revisions >= config.limits.plan_revisions) {
      return blocked(
        ctx,
        `Phase ${phase.id}: plan not approved after ${config.limits.plan_revisions} revisions.`,
        review.success ? blockingFindings.map((f) => `${f.type}/${f.severity}: ${f.description}`) : [reviewRes.summary],
      );
    }
    revisions++;
    discardDecisionProposals(ctx, reviewRes);
    if (planEnvelope) discardDecisionProposals(ctx, planEnvelope);
    planEnvelope = null;
    planReviewEnvelope = null;
    reviewNotes = review.success
      ? blockingFindings.map((f) => `${f.type}/${f.severity}: ${f.description}`)
      : [`Reviewer verdict (unstructured): ${reviewRes.summary}`];
    plan = null;
  }
  if (planEnvelope) commitDecisionProposals(ctx, planEnvelope);
  if (planReviewEnvelope) commitDecisionProposals(ctx, planReviewEnvelope);
  bus.emit('run.plan_approved', { message: 'Plan approved.' });

  // Baseline snapshot of the working tree (excluding .rijo internals) taken
  // before any worker patch is applied — the reviewer's diff and the phase
  // commit are computed against this.
  const recoveryBaselinePath = phaseRecoveryBaselinePath(ctx, milestone.id, phase.id);
  const taskStates = readPlan(pp.plan).tasks.map((task) => task.status);
  const hasAppliedTaskProgress = taskStates.some((status) =>
    ['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(status),
  );
  // Keep the first durable source baseline until the phase finalizes. Task
  // projections can temporarily return to PENDING during native recovery.
  // Replacing the baseline in that state can misclassify verified worker
  // output as a pre-existing user change and leave it outside the phase commit.
  const recoveredBaseline = readPhaseExecutionBaseline(recoveryBaselinePath);
  if (hasAppliedTaskProgress && !recoveredBaseline) {
    return blocked(ctx, `Phase ${phase.id}: source baseline needed for safe recovery is missing.`, [
      'Implemented task paths are present, but RIJO cannot prove which dirty bytes came from its isolated workers.',
      'The checkout was left unchanged; restore the phase runtime baseline or reconcile the source changes explicitly.',
    ]);
  }
  const phaseBaseline: FileSnapshot = recoveredBaseline?.snapshot ?? snapshotFiles(ctx.projectRoot);
  const dirtyAtStart = recoveredBaseline?.dirtyAtStart ?? initialDirtyAtStart;
  let controlledSnapshot = recoveredBaseline?.controlledSnapshot ?? phaseBaseline;
  if (recoveredBaseline) {
    const resumeDelta = diffSnapshots(controlledSnapshot, snapshotFiles(ctx.projectRoot));
    const overlapping = resumeDelta.changed.filter((changed) =>
      plan.tasks.some((task) => pathInScope(changed, task.write_scope)),
    );
    if (overlapping.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: task paths changed after RIJO last controlled them.`, [
        `Concurrent paths: ${overlapping.join(', ')}`,
        'RIJO will not appropriate or overwrite these changes; reconcile them explicitly and retry.',
      ]);
    }
  }
  if (!recoveredBaseline) {
    writePhaseRecoveryBaseline(
      recoveryBaselinePath,
      phaseBaseline,
      dirtyAtStart,
      controlledSnapshot,
    );
  }
  const checkpointControlledSnapshot = (): void => {
    controlledSnapshot = snapshotFiles(ctx.projectRoot);
    writePhaseRecoveryBaseline(
      recoveryBaselinePath,
      phaseBaseline,
      dirtyAtStart,
      controlledSnapshot,
    );
  };

  // Deterministic resume: a RUNNING task from a crashed run is reset (its
  // orphan workspace was already discarded — nothing it did survived); a
  // FAILED/BLOCKED task gets a fresh attempt from a clean baseline; an
  // IMPLEMENTED/VERIFYING/VERIFIED task is re-verified, never re-implemented
  // and never silently promoted.
  {
    const current = readPlan(pp.plan);
    for (const t of current.tasks) {
      if (t.status === 'RUNNING') {
        transition(t.id, 'FAILED', 'interrupted run — attempt discarded');
        transition(t.id, 'PENDING', 'reset for a fresh attempt');
      } else if (t.status === 'FAILED' || t.status === 'BLOCKED') {
        transition(t.id, 'PENDING', 'reset for a fresh attempt');
      }
    }
  }

  // ---- EXECUTE (fresh isolated workspace per task; parallel only for disjoint scopes)
  const groups = parallelGroups(plan.tasks, config.limits.max_parallel_agents);
  const totalTasks = plan.tasks.length;
  for (const group of groups) {
    const statuses = new Map(readPlan(pp.plan).tasks.map((t) => [t.id, t.status]));
    const pending = group.filter((t) => statuses.get(t.id) === 'PENDING');
    if (pending.length === 0) continue;

    // All lifecycle transitions FIRST (each one touches the canonical plan),
    // THEN the workspaces are created — every attempt in the group captures
    // the same, final canonical baseline.
    for (const t of pending) transition(t.id, 'RUNNING');
    const routingFor = (t: { write_scope?: string[]; code_files?: string[] }) => {
      const scopePaths = [...(t.write_scope ?? []), ...(t.code_files ?? [])];
      return {
        stage: 'EXECUTE' as const,
        requirementTags: inferSecurityTag(scopePaths),
        paths: scopePaths,
        highRisk: inferHighRisk(scopePaths),
      };
    };
    const attempts: ReplaceableAttempt[] = [];
    for (const t of pending) {
      const taskOwnsTestPath = t.write_scope.some((scope) =>
        /(^|\/)(__tests__|tests?|spec)(\/|\.|$)|\.(test|spec)\.[^.]+$/i.test(scope),
      );
      const tddInstruction =
        t.tdd && taskOwnsTestPath
          ? 'Follow TDD: write a failing test (RED), implement (GREEN), refactor. '
          : t.tdd
            ? 'Tests for this change are allocated to a separate task; do not edit them or any path outside this task write scope. '
            : '';
      const workerTask: AgentTaskDraft = {
        id: `exec-${phase.id}-${t.id}`,
        role: 'worker',
        objective: `Implement task ${t.id}: ${t.name}. ${tddInstruction}Work ONLY inside your isolated workspace; do not modify files outside your write scope; if you need to, stop and request a new allocation. You MAY use the host's local file-inspection and patch/edit tools inside that workspace. Do NOT execute repository code or run verification commands, tests, npm, git, network tools, or project processes yourself; the framework runs verification after you finish. Once the code is written into your write scope, return ok:true; report ok:false ONLY if you genuinely could not implement the change (never merely because you could not run the tests).`,
        canonical_files: [ctx.paths.rules, pp.spec, pp.plan].filter(exists),
        code_files: t.files.map((f) => path.resolve(ctx.projectRoot, f)),
        write_scope: t.write_scope,
        acceptance_criteria: [t.evidence_expected],
        verification_commands: t.tests,
        return_format: 'JSON payload: {done: boolean, notes: string}. Also list files_written.',
        notes: '',
        workspace: null,
        canonical_baseline: null,
      };
      attempts.push(replaceableAttempt(ctx, workerTask, {}, routingFor(workerTask)));
    }

    const taskIdx = plan.tasks.findIndex((t) => t.id === pending[0]!.id) + 1;
    stage('EXECUTE', `Execute ${pending.map((t) => t.id).join('+')}.`, {});
    bus.emit('run.task_start', {
      stage: 'EXECUTE',
      task: { id: pending[0]!.id, index: taskIdx, total: totalTasks, name: pending[0]!.name },
      agent: { role: 'worker', id: attempts[0]!.attempt.task.id },
      message: pending.map((t) => t.name).join(' | '),
    });

    const discardAll = () => attempts.forEach((a) => a.attempt.workspace.discard());
    let results: ValidatedAgentEnvelope[];
    try {
      results = await dispatchBatch(
        ctx,
        attempts.map((a) => a.attempt.task),
        undefined,
        (task) => routingFor(task),
        (_task, i) => attempts[i]!.prepareReplacement,
      );
    } catch (err) {
      if (isNativeResultRequired(err)) throw err;
      discardAll();
      pending.forEach((t) => transition(t.id, 'FAILED', 'dispatch error'));
      return blocked(ctx, `Phase ${phase.id}: worker dispatch failed.`, [String((err as Error).message)]);
    }

    // Any failed result discards EVERY workspace of the group before anything
    // is applied — a failed attempt can never leave changes incorporated.
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const t = pending[i]!;
      if (!r.ok) {
        discardAll();
        pending.forEach((x) => transition(x.id, 'FAILED', `group failed at ${t.id}`));
        return blocked(ctx, `Phase ${phase.id}: task ${t.id} failed.`, [r.summary, ...r.scope_requests.map((s) => `scope request: ${s}`)]);
      }
    }

    // Canonical baseline must still be current: an attempt briefed against an
    // older canonical context can never be applied.
    const baselineNow = canonicalBaselineHash(paths);
    const stale = attempts.filter((a) => a.attempt.task.canonical_baseline !== baselineNow);
    if (stale.length > 0) {
      discardAll();
      pending.forEach((t) => transition(t.id, 'FAILED', 'canonical baseline drift'));
      return blocked(ctx, `Phase ${phase.id}: canonical context changed while attempts ran (CANONICAL_DRIFT).`, [
        `Stale attempts: ${stale.map((a) => a.attempt.task.id).join(', ')}. Re-run to retry against the current baseline.`,
      ]);
    }

    // Authoritative scope enforcement per INDIVIDUAL task: the real filesystem
    // delta of each workspace (including .rijo, removals, renames, symlinks) is
    // validated against that task's own scope — never the group union, and the
    // agent's files_written report is irrelevant.
    try {
      for (const a of attempts) a.attempt.workspace.validate();
    } catch (err) {
      discardAll();
      pending.forEach((t) => transition(t.id, 'FAILED', 'boundary violation'));
      if (
        err instanceof WorkspaceScopeError ||
        err instanceof CanonicalWriteError ||
        err instanceof SymlinkEscapeError
      ) {
        return blocked(ctx, `Phase ${phase.id}: ${err.message}`, []);
      }
      throw err;
    }

    // Apply the validated patches to the controlled checkout. A conflict with a
    // concurrent (user) change blocks with no partial merge.
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const t = pending[i]!;
      try {
        a.attempt.workspace.applyVerifiedPatch();
      } catch (err) {
        discardAll();
        transition(t.id, 'FAILED', 'patch conflict');
        if (err instanceof PatchConflictError) {
          return blocked(ctx, `Phase ${phase.id}: ${err.message}`, [
            'Commit or revert the concurrent change, then re-run.',
          ]);
        }
        throw err;
      }
      a.attempt.workspace.discard();
      transition(t.id, 'IMPLEMENTED');
      bus.emit('run.task_done', {
        completedUnits: readPlan(pp.plan).tasks.filter((x) => x.status !== 'PENDING' && x.status !== 'RUNNING').length,
        totalUnits: totalTasks,
        message: `Task ${t.id} is implemented but not verified.`,
      });
    }
    for (const result of results) commitDecisionProposals(ctx, result);
    checkpointControlledSnapshot();
  }

  // ---- Evidence gate: a phase MUST produce real command evidence. A task may
  // contribute zero commands only if it carries an explicit, auditable
  // no_execution_justification (e.g. a pure docs edit). Otherwise the phase is
  // BLOCKED rather than silently passing with zero verifications.
  const projectCommands = detectProjectCommands(ctx);
  const tasksNeedingEvidence = plan.tasks.filter((t) => !t.no_execution_justification);
  const anyTaskHasTests = plan.tasks.some((t) => t.tests.length > 0);
  if (!anyTaskHasTests && projectCommands.length === 0 && tasksNeedingEvidence.length > 0) {
    return blocked(
      ctx,
      `Phase ${phase.id}: NO_VERIFICATION_EVIDENCE — no verification command available for tasks ${tasksNeedingEvidence
        .map((t) => t.id)
        .join(', ')}.`,
      [
        'Declare tests on each task, add a project verification script, or set an explicit no_execution_justification for genuinely non-executable work.',
      ],
    );
  }

  // ---- VERIFY + CODE_REVIEW loop (bounded)
  let reviewLoops = 0;
  let evidences: CommandEvidence[] = [];
  while (true) {
    stage('VERIFY', 'Run build, lint, and focused tests.');
    for (const t of readPlan(pp.plan).tasks) {
      if (t.status === 'IMPLEMENTED' || t.status === 'VERIFIED') transition(t.id, 'VERIFYING');
    }
    evidences = [
      ...prepareProjectDependencies(ctx, phaseBaseline, projectCommands),
      ...runVerification(ctx, plan, projectCommands),
    ];

    // A command rejected by the security policy is a hard block, never a
    // repairable failure — we do not loop a worker on a forbidden command.
    const policyBlocked = evidences.filter((e) => e.blocked);
    if (policyBlocked.length > 0) {
      return blocked(
        ctx,
        `Phase ${phase.id}: verification command blocked by security policy.`,
        policyBlocked.map((e) => `${e.command} → ${e.summary}`),
      );
    }

    // Enforce the evidence gate at runtime too: if nothing actually ran and
    // some task required evidence, block.
    if (evidences.length === 0 && tasksNeedingEvidence.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: NO_VERIFICATION_EVIDENCE — zero commands executed.`, [
        'Every task without a no_execution_justification must produce at least one verification command.',
      ]);
    }

    const failures = evidences.filter((e) => e.exit_code !== 0);
    if (failures.length > 0) {
      if (reviewLoops >= config.limits.qa_fix_loops) {
        return blocked(
          ctx,
          `Phase ${phase.id}: verification still failing after ${reviewLoops} repair attempts.`,
          failures.map((f) => `${f.command} → exit ${f.exit_code}\n${f.summary.slice(0, 400)}`),
        );
      }
      reviewLoops++;
      const repairOutcome = await runRepairAttempt(ctx, phase.id, pp, plan, {
        id: `verify-fix-${phase.id}-l${reviewLoops}`,
        objective: 'Fix the verification failures below with the smallest coherent change. Do not weaken tests to make them pass.',
        acceptance: ['All verification commands exit 0'],
        commands: failures.map((f) => f.command),
        notes: failures.map((f) => `${f.command} → exit ${f.exit_code}\n${f.summary.slice(0, 800)}`).join('\n\n'),
      });
      if (repairOutcome) return repairOutcome;
      checkpointControlledSnapshot();
      continue;
    }

    for (const t of readPlan(pp.plan).tasks) {
      if (t.status === 'VERIFYING') {
        transition(t.id, 'VERIFIED');
        await durableCheckpoint(ctx, `task:${phase.id}:${t.id}:verified`, {
          commit: ctx.git.headCommit(ctx.projectRoot),
        });
      }
    }

    stage('CODE_REVIEW', 'Run an independent code review.');
    const diffSummary = changedFilesReport(ctx, phaseBaseline);
    const crTask: AgentTaskDraft = {
      id: `code-review-${phase.id}-l${reviewLoops}`,
      role: 'reviewer',
      objective:
        'Independent code review. You receive the spec, the plan, the diff and the verification evidence — never the implementer reasoning. Classify each finding as intent_gap, spec_gap, implementation_bug, test_gap, security_risk, quality_issue, defer or reject.',
      canonical_files: [pp.spec, pp.plan].filter(exists),
      code_files: plan.tasks.flatMap((t) => t.files.map((f) => path.resolve(ctx.projectRoot, f))),
      write_scope: [],
      acceptance_criteria: [],
      verification_commands: [],
      return_format: 'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}',
      notes: `DIFF SUMMARY:\n${diffSummary}\n\nEVIDENCE:\n${evidences.map((e) => `${e.command} → exit ${e.exit_code}`).join('\n')}`,
      workspace: null,
      canonical_baseline: null,
    };
    const reviewedPaths = plan.tasks.flatMap((t) => [...t.files, ...t.write_scope]);
    const { result: crRes, violation: crViolation } = await dispatchReadOnly(ctx, crTask, {
      stage: 'CODE_REVIEW',
      requirementTags: inferSecurityTag(reviewedPaths),
      authorProfiles: ['senior-software-engineer'],
    });
    if (crViolation.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: code reviewer (read-only) modified the checkout.`, crViolation);
    }
    // An ATTEMPT failure (ok:false — e.g. an intermittent headless read-only
    // glitch) is RECOVERABLE: the code is already implemented and verified, so
    // simply re-run the verify+review cycle within the review_loops budget
    // rather than discarding a green phase on a transient review blip.
    // A COMPLETED review whose verdict is not in schema is NOT auto-approval
    // (that would silently drop the gate): treat it as an unresolved review with
    // the reviewer's summary as the finding, and run the bounded repair loop
    // below — it only blocks once the review_loops budget is exhausted.
    if (!crRes.ok) {
      discardDecisionProposals(ctx, crRes);
      if (isWorkflowCancellation(crRes) || reviewLoops >= config.limits.review_loops) {
        return blocked(ctx, `Phase ${phase.id}: code review failed to produce a verdict after ${config.limits.review_loops} cycles.`, [crRes.summary]);
      }
      reviewLoops++;
      continue;
    }
    const cr = ReviewPayloadSchema.safeParse(crRes.payload);
    if (!cr.success) {
      discardDecisionProposals(ctx, crRes);
      if (reviewLoops >= config.limits.review_loops) {
        return blocked(ctx, `Phase ${phase.id}: code review produced no usable verdict after ${config.limits.review_loops} cycles.`, [crRes.summary]);
      }
      reviewLoops++;
      const repairOutcome = await runRepairAttempt(ctx, phase.id, pp, plan, {
        id: `review-fix-${phase.id}-l${reviewLoops}`,
        objective: 'Address the reviewer feedback below with minimal coherent changes; keep all verification commands passing.',
        acceptance: ['Reviewer feedback addressed', 'Verification commands still pass'],
        commands: [],
        notes: `Reviewer verdict (unstructured): ${crRes.summary}`,
      });
      if (repairOutcome) return repairOutcome;
      checkpointControlledSnapshot();
      continue;
    }
    writeReviewDoc(pp, cr.data, reviewLoops, now);
    touchManifest(paths, () => {}, now);
    const blockingSeverities = new Set(['blocker', 'critical', 'high']);
    const specGaps = cr.data.findings.filter(
      (f) => (f.type === 'intent_gap' || f.type === 'spec_gap') && blockingSeverities.has(f.severity),
    );
    if (specGaps.length > 0) {
      return blocked(
        ctx,
        `Phase ${phase.id}: review found spec/intent gaps; returning to specification instead of patching locally.`,
        specGaps.map((f) => `${f.type}: ${f.description}`),
      );
    }
    // Medium/low review observations are recorded in REVIEW.md, but cannot
    // overturn green executable evidence or manufacture a technical blocker.
    // This is the operational form of the autonomous-decision policy: only a
    // high-impact finding enters the bounded repair/block path.
    const actionable = cr.data.findings.filter(
      (f) => !['defer', 'reject'].includes(f.type) && blockingSeverities.has(f.severity),
    );
    if (cr.data.approved || actionable.length === 0) {
      commitDecisionProposals(ctx, crRes);
      break;
    }
    if (reviewLoops >= config.limits.review_loops) {
      return blocked(
        ctx,
        `Phase ${phase.id}: review findings persist after ${config.limits.review_loops} repair cycles.`,
        actionable.map((f) => `${f.type}/${f.severity}: ${f.description}`),
      );
    }
    reviewLoops++;
    discardDecisionProposals(ctx, crRes);
    const repairOutcome = await runRepairAttempt(ctx, phase.id, pp, plan, {
      id: `review-fix-${phase.id}-l${reviewLoops}`,
      objective: 'Address the valid review findings below with minimal coherent changes.',
      acceptance: ['Findings addressed', 'Verification commands still pass'],
      commands: [],
      notes: actionable.map((f) => `${f.type}/${f.severity}: ${f.description}${f.file ? ` (${f.file})` : ''}`).join('\n'),
    });
    if (repairOutcome) return repairOutcome;
    checkpointControlledSnapshot();
  }

  // ---- UI_SMOKE (only for UI surfaces; honest about capability)
  let uiSmokeNote = 'not applicable (no UI surface in this phase)';
  if (phase.ui_surface) {
    if (!ctx.runner.capabilities.browser) {
      uiSmokeNote = 'SKIPPED: browser capability unavailable in this runtime (recorded, not simulated)';
      bus.emit('run.ui_smoke', { stage: 'UI_SMOKE', message: 'The browser is unavailable. Record the smoke test as not executed.' });
    } else {
      stage('UI_SMOKE', 'Run a visual smoke test on the changed surface.');
      const screenshotScope = path.relative(ctx.projectRoot, path.join(milestone.paths.qaDir, 'screenshots')).split(path.sep).join('/') + '/**';
      const smokeTask: AgentTaskDraft = {
        id: `ui-smoke-${phase.id}`,
        role: 'qa',
        objective: 'UI smoke: load the changed surface, check console and network for errors, exercise the main navigation, capture a minimal screenshot.',
        canonical_files: [pp.spec].filter(exists),
        code_files: [],
        write_scope: [screenshotScope],
        acceptance_criteria: ['No unhandled console errors', 'No failing network requests on the main flow'],
        verification_commands: [],
        return_format: 'JSON payload: {passed, console_errors[], network_errors[], screenshot, notes}',
        notes: '',
        workspace: null,
        canonical_baseline: null,
      };
      const smokeHandle = replaceableAttempt(ctx, smokeTask, { canonicalWriteScope: [screenshotScope] }, { stage: 'UI_SMOKE' });
      const smokeRes = await dispatch(ctx, smokeHandle.attempt.task, { stage: 'UI_SMOKE' }, { prepareReplacement: smokeHandle.prepareReplacement });
      const smoke = UiSmokePayloadSchema.safeParse(smokeRes.payload);
      try {
        if (!smokeRes.ok || !smoke.success || !smoke.data.passed) {
          return blocked(ctx, `Phase ${phase.id}: UI smoke failed.`, [
            smokeRes.summary,
            ...(smoke.success ? [...smoke.data.console_errors, ...smoke.data.network_errors] : []),
          ]);
        }
        smokeHandle.attempt.workspace.applyVerifiedPatch();
        commitDecisionProposals(ctx, smokeRes);
      } catch (err) {
        return blocked(ctx, `Phase ${phase.id}: UI smoke violated workspace boundaries.`, [String((err as Error).message)]);
      } finally {
        smokeHandle.attempt.workspace.discard();
      }
      uiSmokeNote = `passed${smoke.data.screenshot ? ` (screenshot: ${smoke.data.screenshot})` : ''}`;
    }
  }

  // ---- PERSIST + FINALIZE: transactional, resumable phase finalization (P0.7).
  // Verification and review have passed. A durable FINALIZING marker now guards
  // the requirement/roadmap/checkpoint DONE flips and the two-commit-plus-seal
  // sequence (C1 = code + phase state without self-reference; C2 = evidence
  // pointing at C1; seal), so a crash between any two steps is always observable
  // as a clean pre-finalization state (retryable) or a fully DONE-and-committed
  // phase — never a DONE phase without its commits. See workflows/finalize.ts;
  // an interrupted finalization is resumed under the lock by reconcileFinalization.
  stage('PERSIST', 'Persist the summary, evidence, and state.');
  const finalization = await stageFinalization(ctx, {
    milestone,
    phase,
    pp,
    plan,
    evidences,
    uiSmokeNote,
    phaseBaseline,
    dirtyAtStart,
  });
  if (finalization.ok) fs.rmSync(recoveryBaselinePath, { force: true });
  return finalization;
}

/**
 * Run a repair worker in an isolated workspace and apply its verified patch.
 * Returns a WorkflowOutcome on failure (to be returned by the caller), null on
 * success.
 */
async function runRepairAttempt(
  ctx: WorkflowContext,
  phaseId: string,
  pp: PhasePaths,
  plan: PhasePlan,
  spec: { id: string; objective: string; acceptance: string[]; commands: string[]; notes: string },
): Promise<WorkflowOutcome | null> {
  const repairTask: AgentTaskDraft = {
    id: spec.id,
    role: 'worker',
    objective: `${spec.objective} You MAY use the host's local file-inspection and patch/edit tools inside the isolated workspace. Do NOT execute repository code or run verification commands, tests, npm, git, network tools, or project processes yourself; the framework re-runs verification after you finish. Edit the code in your write scope and return ok:true; report ok:false ONLY if you genuinely could not make the change (never merely because you could not run the tests).`,
    canonical_files: [pp.spec, pp.plan].filter(exists),
    code_files: plan.tasks.flatMap((t) => t.files.map((f) => path.resolve(ctx.projectRoot, f))),
    write_scope: plan.tasks.flatMap((t) => t.write_scope),
    acceptance_criteria: spec.acceptance,
    verification_commands: spec.commands,
    return_format: 'JSON payload: {done: boolean, notes: string}',
    notes: spec.notes,
    workspace: null,
    canonical_baseline: null,
  };
  const handle = replaceableAttempt(ctx, repairTask, {}, { stage: 'EXECUTE' });
  let preserveNativeWorkspace = false;
  try {
    const res = await dispatch(ctx, handle.attempt.task, { stage: 'EXECUTE' }, { prepareReplacement: handle.prepareReplacement });
    if (!res.ok) {
      return blocked(ctx, `Phase ${phaseId}: repair worker failed.`, [res.summary]);
    }
    handle.attempt.workspace.applyVerifiedPatch();
    commitDecisionProposals(ctx, res);
    return null;
  } catch (err) {
    if (isNativeResultRequired(err)) {
      preserveNativeWorkspace = true;
      throw err;
    }
    if (
      err instanceof WorkspaceScopeError ||
      err instanceof CanonicalWriteError ||
      err instanceof SymlinkEscapeError ||
      err instanceof PatchConflictError
    ) {
      return blocked(ctx, `Phase ${phaseId}: repair attempt discarded — ${err.message}`, []);
    }
    throw err;
  } finally {
    if (!preserveNativeWorkspace) handle.attempt.workspace.discard();
  }
}

/** Detect the project's own verification scripts (npm scripts today). */
function detectProjectCommands(ctx: WorkflowContext): string[] {
  const commands: string[] = [];
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
      for (const s of ['typecheck', 'lint', 'build', 'test']) {
        if (pkg.scripts?.[s]) commands.push(`npm run ${s}`);
      }
    } catch {
      /* unparseable package.json — plan tests only */
    }
  }
  return commands;
}

/**
 * Install newly declared Node.js dependencies through the managed command
 * gate before project scripts run. The command policy disables lifecycle
 * scripts and enables network access only for this explicit installation.
 */
function prepareProjectDependencies(
  ctx: WorkflowContext,
  phaseBaseline: FileSnapshot,
  projectCommands: string[],
): CommandEvidence[] {
  if (!projectCommands.some((command) => command.startsWith('npm run '))) return [];
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (!exists(pkgPath)) return [];

  const delta = diffSnapshots(phaseBaseline, snapshotFiles(ctx.projectRoot));
  const nodeModulesPath = path.join(ctx.projectRoot, 'node_modules');
  if (!delta.changed.includes('package.json') && exists(nodeModulesPath)) return [];

  let packageCount = 0;
  try {
    const pkg = JSON.parse(readText(pkgPath)) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    packageCount =
      Object.keys(pkg.dependencies ?? {}).length +
      Object.keys(pkg.devDependencies ?? {}).length +
      Object.keys(pkg.optionalDependencies ?? {}).length;
  } catch {
    return [];
  }
  if (packageCount === 0) return [];

  const command = 'npm install --no-audit --no-fund';
  const evidence = ctx.shell.run(command, {
    cwd: ctx.projectRoot,
    allowInstall: true,
    timeoutMs: 10 * 60 * 1000,
  });
  ctx.bus.emit(
    'run.verify_command',
    { message: `${command} → exit ${evidence.exit_code}` },
    { command, exit: evidence.exit_code, managed_install: true },
  );
  return [evidence];
}

function runVerification(ctx: WorkflowContext, plan: PhasePlan, projectCommands: string[]): CommandEvidence[] {
  const commands = new Set<string>(projectCommands);
  for (const t of plan.tasks) for (const test of t.tests) commands.add(test);
  const evidences: CommandEvidence[] = [];
  for (const cmd of commands) {
    const ev = ctx.shell.run(cmd, { cwd: ctx.projectRoot });
    evidences.push(ev);
    ctx.bus.emit('run.verify_command', { message: `${cmd} → exit ${ev.exit_code}` }, { command: cmd, exit: ev.exit_code });
  }
  return evidences;
}

/**
 * Give the reviewer the REAL change set: for every path changed since the phase
 * baseline, include the file's current (redacted, truncated) content. This is
 * the actual patch the reviewer needs — not a bare list of file names.
 */
function changedFilesReport(ctx: WorkflowContext, baseline: FileSnapshot): string {
  const delta = diffSnapshots(baseline, snapshotFiles(ctx.projectRoot));
  if (delta.changed.length === 0) return 'no source changes detected';
  const parts: string[] = [];
  for (const rel of delta.changed.slice(0, 40)) {
    if (delta.removed.includes(rel)) {
      parts.push(`--- removed: ${rel}`);
      continue;
    }
    const content = readTextIfExists(path.join(ctx.projectRoot, rel)) ?? '';
    const shown = content.length > 4000 ? `${content.slice(0, 4000)}\n…(truncated)` : content;
    parts.push(`--- ${delta.added.includes(rel) ? 'added' : 'modified'}: ${rel}\n${redact(shown)}`);
  }
  if (delta.changed.length > 40) parts.push(`…and ${delta.changed.length - 40} more changed files`);
  return parts.join('\n\n');
}

function writeReviewDoc(pp: PhasePaths, review: ReviewPayload, loop: number, now: () => Date): void {
  writeFileAtomic(
    pp.review,
    serializeFrontmatter(
      { approved: review.approved, loop, reviewed_at: now().toISOString(), findings: review.findings },
      [
        `# Review`,
        '',
        review.findings.length
          ? review.findings.map((f) => `- **${f.type}** (${f.severity}): ${f.description}${f.file ? ` — ${f.file}` : ''}`).join('\n')
          : 'No findings.',
        '',
      ].join('\n'),
    ),
  );
}
