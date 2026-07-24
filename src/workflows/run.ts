import * as path from 'node:path';
import { z } from 'zod';
import { exists, readText, readTextIfExists, writeFileAtomic, ensureDir } from '../core/fsx.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { phasePaths, type PhasePaths } from '../core/paths.js';
import { readState, writeState, initialState } from '../core/state.js';
import { touchManifest, canonicalBaselineHash } from '../core/manifest.js';
import { activeMilestone, type MilestoneRef } from '../core/milestones.js';
import { readRequirements, readRoadmap, writeRequirements, writeRoadmap, nextPhase, type RoadmapDoc } from '../core/roadmap.js';
import { readPlan, writePlan, lintPlan, setTaskStatus, parallelGroups } from '../core/plan.js';
import { validateStateIntegrity } from '../core/traceability.js';
import { checkContextBudget } from '../core/contextBudget.js';
import { snapshotFiles, diffSnapshots, pathInScope, type FileSnapshot } from '../core/scope.js';
import {
  AttemptWorkspace,
  snapshotTree,
  diffTrees,
  WorkspaceScopeError,
  CanonicalWriteError,
  SymlinkEscapeError,
  PatchConflictError,
} from '../core/workspace.js';
import { redact } from '../security/redact.js';
import { PhasePlanSchema, ReviewFindingTypeSchema, FindingSeveritySchema, type RoadmapPhase, type PhasePlan, type TaskStatus } from '../core/schemas/index.js';
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
  prepareAttempt,
  dispatchReadOnly,
  type Attempt,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';
import { inferSecurityTag, inferHighRisk } from './routing.js';

export interface RunOptions {
  /** undefined = resume from STATE.md; 'next' = next ready phase; 'all' = every phase; 'NN' = specific phase */
  target?: string;
}

const ReviewPayloadSchema = z.object({
  approved: z.boolean(),
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

const UiSmokePayloadSchema = z.object({
  passed: z.boolean(),
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
  return withLock(ctx, () => runCore(ctx, opts));
}

/**
 * Run the phase state machine using an EXISTING context and lock. This is what
 * `rijo new --run` composes with, so the run does not try to re-acquire a lock
 * the enclosing `new` already holds.
 */
export async function runCore(ctx: WorkflowContext, opts: RunOptions = {}): Promise<WorkflowOutcome> {
  const { paths, bus } = ctx;
  {
    // ---- LOAD
    bus.emit('run.load', { status: 'running', stage: 'LOAD', message: 'validando manifest, drift e checkpoint' });
    const schemaGuard = guardSchema(ctx);
    if (schemaGuard) return schemaGuard;
    // Orphan-workspace discard and crash recovery already ran in withLock (which
    // also wraps `rijo new --run` composing runCore), so LOAD does not repeat it.
    const integrity = validateStateIntegrity(paths);
    const errors = integrity.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return blocked(ctx, 'State integrity check failed.', errors.map((e) => `${e.code}: ${e.message} — ${e.fix}`));
    }
    const milestone = activeMilestone(paths);
    if (!milestone) return failed(ctx, 'No active milestone in manifest.');
    if (!exists(milestone.paths.roadmap)) return failed(ctx, `Missing ROADMAP.md for ${milestone.id}.`);

    const budget = checkContextBudget(
      [paths.rules, paths.state, milestone.paths.requirements],
      ctx.config.context_budget_bytes,
    );
    if (!budget.withinBudget) {
      bus.emit('run.budget_warning', { message: `contexto automático ${budget.bytes}B excede orçamento ${budget.budget}B` });
    }

    const roadmap = readRoadmap(milestone.paths.roadmap);
    const targets = resolveTargets(ctx, roadmap, opts.target);
    if (targets.length === 0) {
      const allDone = roadmap.phases.every((p) => p.status === 'DONE');
      return completed(
        ctx,
        allDone ? `All ${roadmap.phases.length} phases of ${milestone.id} are DONE.` : 'No ready phase (check dependencies/blockers).',
      );
    }

    for (const phase of targets) {
      const outcome = await executePhase(ctx, milestone, phase);
      if (!outcome.ok) return outcome;
      if (opts.target !== 'all') return outcome;
    }
    return completed(ctx, `Completed ${targets.length} phase(s) of ${milestone.id}.`);
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
  const stage = (s: import('../core/schemas/index.js').Stage, message: string, extra: Record<string, unknown> = {}) =>
    bus.emit(`run.${s.toLowerCase()}`, { status: 'running', stage: s, milestone: milestoneInfo, phase: phaseInfo, message }, extra);

  const markPhase = (status: RoadmapPhase['status'], commit?: string | null) => {
    const doc = readRoadmap(milestone.paths.roadmap);
    const p = doc.phases.find((x) => x.id === phase.id)!;
    p.status = status;
    if (commit !== undefined) p.commit = commit;
    writeRoadmap(milestone.paths.roadmap, doc);
  };

  const checkpoint = (stageName: import('../core/schemas/index.js').Stage, narrative: string, extra: Partial<import('../core/schemas/index.js').StateFrontmatter> = {}) => {
    const prev = readState(paths) ?? initialState(now);
    writeState(
      paths,
      {
        ...prev,
        milestone: milestone.id,
        phase: phase.id,
        stage: stageName,
        updated_at: now().toISOString(),
        ...extra,
      },
      narrative,
    );
    touchManifest(paths, () => {}, now);
  };

  /** Append-only transition event FIRST, then the plan projection, then manifest hashes. */
  const transition = (taskId: string, to: TaskStatus, reason = '') => {
    bus.emit('task.transition', { message: `tarefa ${taskId} → ${to}${reason ? ` (${reason})` : ''}` }, { task: taskId, to, reason });
    setTaskStatus(pp.plan, taskId, to);
    touchManifest(paths, () => {}, now);
  };

  // Record which files were ALREADY dirty before this phase ran: a phase commit
  // must never appropriate pre-existing user changes, and overlapping paths are
  // an explicit conflict rather than a silent sweep.
  const gitStatusAtStart = ctx.git.status(ctx.projectRoot);
  const dirtyAtStart = new Set(gitStatusAtStart.dirtyFiles);

  markPhase('IN_PROGRESS');

  // ---- RESEARCH_DELTA (deterministic: only flag; agents re-research on demand elsewhere)
  stage('RESEARCH_DELTA', 'reutilizando pesquisa armazenada');

  // ---- SPEC_READY
  if (!exists(pp.spec)) {
    stage('SPEC_READY', 'gerando especificação da fase');
    const reqDoc = readRequirements(milestone.paths.requirements);
    const phaseReqs = reqDoc.requirements.filter((r) => r.phase === phase.id);
    const specRel = path.relative(ctx.projectRoot, pp.spec).split(path.sep).join('/');
    const specTask: AgentTaskDraft = {
      id: `spec-${phase.id}`,
      role: 'planner',
      objective: `Write the SPEC.md for phase ${phase.id} (${phase.name}). It must be actionable, testable, tied to real code surfaces, complete and coherent, with observable acceptance scenarios for each requirement.`,
      canonical_files: [paths.rules, milestone.paths.scope, milestone.paths.requirements, milestone.paths.research].filter(exists),
      code_files: [],
      write_scope: [specRel],
      acceptance_criteria: phaseReqs.map((r) => `${r.id}: ${r.acceptance}`),
      verification_commands: [],
      return_format: 'Write SPEC.md to disk (inside your workspace); return a one-line confirmation.',
      notes: `Requirements in this phase:\n${phaseReqs.map((r) => `- ${r.id}: ${r.description}`).join('\n')}`,
      workspace: null,
      canonical_baseline: null,
    };
    // The spec is a canonical artifact: this is an explicitly core-authorized
    // canonical write, isolated in a workspace and applied only after validation.
    const attempt = prepareAttempt(ctx, specTask, { canonicalWriteScope: [specRel] });
    const res = await dispatch(ctx, attempt.task, { stage: 'SPEC_READY' });
    try {
      if (!res.ok || !exists(path.join(attempt.workspace.root, specRel))) {
        return blocked(ctx, `Phase ${phase.id}: spec generation failed.`, [res.summary]);
      }
      attempt.workspace.applyVerifiedPatch();
      touchManifest(paths, () => {}, now);
    } catch (err) {
      return blocked(ctx, `Phase ${phase.id}: spec generation violated workspace boundaries.`, [String((err as Error).message)]);
    } finally {
      attempt.workspace.discard();
    }
  } else {
    stage('SPEC_READY', 'especificação existente validada');
  }

  // ---- PLAN + PLAN_LINT + PLAN_REVIEW (bounded loop)
  const reqDoc = readRequirements(milestone.paths.requirements);
  const knownReqs = new Set(reqDoc.requirements.map((r) => r.id));
  let plan: PhasePlan | null = exists(pp.plan) ? readPlan(pp.plan) : null;
  let revisions = 0;
  let reviewNotes: string[] = [];
  while (true) {
    if (!plan) {
      stage('PLAN', `planejando tarefas (revisão ${revisions})`);
      const planTask: AgentTaskDraft = {
        id: `plan-${phase.id}-r${revisions}`,
        role: 'planner',
        objective: `Produce the execution plan for phase ${phase.id}: between 2 and 4 tasks, exact files or code regions, dependencies, per-worker write scope, tests and expected evidence, parallel flag only for independent tasks with disjoint write scopes. Set tdd=true for testable behavior.`,
        canonical_files: [paths.rules, pp.spec, milestone.paths.requirements].filter(exists),
        code_files: [],
        write_scope: [],
        acceptance_criteria: ['2-4 tasks', 'every task has requirement IDs or technical justification', 'write scopes are exact'],
        verification_commands: [],
        return_format:
          'JSON payload matching PhasePlan: {phase, tasks:[{id:"T01", name, requirement_ids[], technical_justification, files[], write_scope[], depends_on[], parallel, tdd, tests[], evidence_expected}]}',
        notes: reviewNotes.length ? `Previous review issues to address:\n${reviewNotes.join('\n')}` : '',
        workspace: null,
        canonical_baseline: null,
      };
      const { result: res, violation } = await dispatchReadOnly(ctx, planTask, { stage: 'PLAN' });
      if (violation.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: planner (read-only) modified the checkout.`, violation);
      }
      const parsed = PhasePlanSchema.safeParse(res.payload);
      if (!res.ok || !parsed.success) {
        return blocked(ctx, `Phase ${phase.id}: planning failed.`, [res.summary, ...(parsed.success ? [] : [parsed.error.message])]);
      }
      plan = parsed.data;
      plan.phase = phase.id;
      // The PLAN is a canonical artifact written by the CORE from the planner's
      // validated payload — the agent never touches the plan file itself.
      writePlan(pp.plan, plan, `Generated for ${phase.name}.`);
      touchManifest(paths, () => {}, now);
    }

    stage('PLAN_LINT', 'validação determinística do plano');
    const phaseRequirements = reqDoc.requirements.filter((r) => r.phase === phase.id).map((r) => r.id);
    const lintIssues = lintPlan(plan, { knownRequirements: knownReqs, phaseRequirements });
    if (lintIssues.length > 0) {
      if (revisions >= config.limits.plan_revisions) {
        return blocked(ctx, `Phase ${phase.id}: plan lint failed after ${revisions} revisions.`, lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`));
      }
      revisions++;
      reviewNotes = lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`);
      plan = null;
      continue;
    }

    stage('PLAN_REVIEW', 'revisão independente do plano');
    const reviewTask: AgentTaskDraft = {
      id: `plan-review-${phase.id}-r${revisions}`,
      role: 'reviewer',
      objective: `Independent brief review of the phase plan: completeness, coherence, risk, requirement coverage, adherence to rules. You receive spec and plan, never the author's reasoning.`,
      canonical_files: [paths.rules, pp.spec, pp.plan].filter(exists),
      code_files: [],
      write_scope: [],
      acceptance_criteria: [],
      verification_commands: [],
      return_format: 'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}',
      notes: '',
      workspace: null,
      canonical_baseline: null,
    };
    const { result: reviewRes, violation: reviewViolation } = await dispatchReadOnly(ctx, reviewTask, {
      stage: 'PLAN_REVIEW',
      authorProfiles: ['product-manager', 'system-architect'],
    });
    if (reviewViolation.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: plan reviewer (read-only) modified the checkout.`, reviewViolation);
    }
    const review = ReviewPayloadSchema.safeParse(reviewRes.payload);
    if (!reviewRes.ok || !review.success) {
      return blocked(ctx, `Phase ${phase.id}: plan review failed to produce a verdict.`, [reviewRes.summary]);
    }
    if (review.data.approved) break;
    if (revisions >= config.limits.plan_revisions) {
      return blocked(
        ctx,
        `Phase ${phase.id}: plan not approved after ${config.limits.plan_revisions} revisions.`,
        review.data.findings.map((f) => `${f.type}/${f.severity}: ${f.description}`),
      );
    }
    revisions++;
    reviewNotes = review.data.findings.map((f) => `${f.type}: ${f.description}`);
    plan = null;
  }
  bus.emit('run.plan_approved', { message: 'plano aprovado' });

  // Baseline snapshot of the working tree (excluding .rijo internals) taken
  // before any worker patch is applied — the reviewer's diff and the phase
  // commit are computed against this.
  const phaseBaseline: FileSnapshot = snapshotFiles(ctx.projectRoot);

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
    const attempts: Attempt[] = [];
    for (const t of pending) {
      const workerTask: AgentTaskDraft = {
        id: `exec-${phase.id}-${t.id}`,
        role: 'worker',
        objective: `Implement task ${t.id}: ${t.name}. ${t.tdd ? 'Follow TDD: write a failing test (RED), implement (GREEN), refactor. ' : ''}Work ONLY inside your isolated workspace; do not modify files outside your write scope; if you need to, stop and request a new allocation.`,
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
      attempts.push(prepareAttempt(ctx, workerTask));
    }

    const taskIdx = plan.tasks.findIndex((t) => t.id === pending[0]!.id) + 1;
    stage('EXECUTE', `executando ${pending.map((t) => t.id).join('+')}`, {});
    bus.emit('run.task_start', {
      stage: 'EXECUTE',
      task: { id: pending[0]!.id, index: taskIdx, total: totalTasks, name: pending[0]!.name },
      agent: { role: 'worker', id: attempts[0]!.task.id },
      message: pending.map((t) => t.name).join(' | '),
    });

    const discardAll = () => attempts.forEach((a) => a.workspace.discard());
    let results: AgentResult[];
    try {
      results = await dispatchBatch(ctx, attempts.map((a) => a.task), undefined, (task) => {
        const scopePaths = [...(task.write_scope ?? []), ...(task.code_files ?? [])];
        return {
          stage: 'EXECUTE',
          requirementTags: inferSecurityTag(scopePaths),
          paths: scopePaths,
          highRisk: inferHighRisk(scopePaths),
        };
      });
    } catch (err) {
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
    const stale = attempts.filter((a) => a.task.canonical_baseline !== baselineNow);
    if (stale.length > 0) {
      discardAll();
      pending.forEach((t) => transition(t.id, 'FAILED', 'canonical baseline drift'));
      return blocked(ctx, `Phase ${phase.id}: canonical context changed while attempts ran (CANONICAL_DRIFT).`, [
        `Stale attempts: ${stale.map((a) => a.task.id).join(', ')}. Re-run to retry against the current baseline.`,
      ]);
    }

    // Authoritative scope enforcement per INDIVIDUAL task: the real filesystem
    // delta of each workspace (including .rijo, removals, renames, symlinks) is
    // validated against that task's own scope — never the group union, and the
    // agent's files_written report is irrelevant.
    try {
      for (const a of attempts) a.workspace.validate();
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
        a.workspace.applyVerifiedPatch();
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
      a.workspace.discard();
      transition(t.id, 'IMPLEMENTED');
      bus.emit('run.task_done', {
        completedUnits: readPlan(pp.plan).tasks.filter((x) => x.status !== 'PENDING' && x.status !== 'RUNNING').length,
        totalUnits: totalTasks,
        message: `tarefa ${t.id} implementada (não verificada)`,
      });
    }
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
    stage('VERIFY', 'executando build, lint e testes direcionados');
    for (const t of readPlan(pp.plan).tasks) {
      if (t.status === 'IMPLEMENTED' || t.status === 'VERIFIED') transition(t.id, 'VERIFYING');
    }
    evidences = runVerification(ctx, plan, projectCommands);

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
      continue;
    }

    for (const t of readPlan(pp.plan).tasks) {
      if (t.status === 'VERIFYING') transition(t.id, 'VERIFIED');
    }

    stage('CODE_REVIEW', 'revisão independente do código');
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
    const cr = ReviewPayloadSchema.safeParse(crRes.payload);
    if (!crRes.ok || !cr.success) {
      return blocked(ctx, `Phase ${phase.id}: code review failed to produce a verdict.`, [crRes.summary]);
    }
    writeReviewDoc(pp, cr.data, reviewLoops, now);
    touchManifest(paths, () => {}, now);
    const specGaps = cr.data.findings.filter((f) => f.type === 'intent_gap' || f.type === 'spec_gap');
    if (specGaps.length > 0) {
      return blocked(
        ctx,
        `Phase ${phase.id}: review found spec/intent gaps; returning to specification instead of patching locally.`,
        specGaps.map((f) => `${f.type}: ${f.description}`),
      );
    }
    const actionable = cr.data.findings.filter((f) => !['defer', 'reject'].includes(f.type));
    if (cr.data.approved || actionable.length === 0) break;
    if (reviewLoops >= config.limits.review_loops) {
      return blocked(
        ctx,
        `Phase ${phase.id}: review findings persist after ${config.limits.review_loops} repair cycles.`,
        actionable.map((f) => `${f.type}/${f.severity}: ${f.description}`),
      );
    }
    reviewLoops++;
    const repairOutcome = await runRepairAttempt(ctx, phase.id, pp, plan, {
      id: `review-fix-${phase.id}-l${reviewLoops}`,
      objective: 'Address the valid review findings below with minimal coherent changes.',
      acceptance: ['Findings addressed', 'Verification commands still pass'],
      commands: [],
      notes: actionable.map((f) => `${f.type}/${f.severity}: ${f.description}${f.file ? ` (${f.file})` : ''}`).join('\n'),
    });
    if (repairOutcome) return repairOutcome;
  }

  // ---- UI_SMOKE (only for UI surfaces; honest about capability)
  let uiSmokeNote = 'not applicable (no UI surface in this phase)';
  if (phase.ui_surface) {
    if (!ctx.runner.capabilities.browser) {
      uiSmokeNote = 'SKIPPED: browser capability unavailable in this runtime (recorded, not simulated)';
      bus.emit('run.ui_smoke', { stage: 'UI_SMOKE', message: 'browser indisponível; smoke registrado como não executado' });
    } else {
      stage('UI_SMOKE', 'smoke visual da superfície alterada');
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
      const smokeAttempt = prepareAttempt(ctx, smokeTask, { canonicalWriteScope: [screenshotScope] });
      const smokeRes = await dispatch(ctx, smokeAttempt.task, { stage: 'UI_SMOKE' });
      const smoke = UiSmokePayloadSchema.safeParse(smokeRes.payload);
      try {
        if (!smokeRes.ok || !smoke.success || !smoke.data.passed) {
          return blocked(ctx, `Phase ${phase.id}: UI smoke failed.`, [
            smokeRes.summary,
            ...(smoke.success ? [...smoke.data.console_errors, ...smoke.data.network_errors] : []),
          ]);
        }
        smokeAttempt.workspace.applyVerifiedPatch();
      } catch (err) {
        return blocked(ctx, `Phase ${phase.id}: UI smoke violated workspace boundaries.`, [String((err as Error).message)]);
      } finally {
        smokeAttempt.workspace.discard();
      }
      uiSmokeNote = `passed${smoke.data.screenshot ? ` (screenshot: ${smoke.data.screenshot})` : ''}`;
    }
  }

  // ---- PERSIST: finalize ALL phase artifacts BEFORE the commit, WITHOUT any
  // self-referencing hash. The C1 code commit contains code + tests + final
  // phase state; the hash cross-references land in a separate evidence commit
  // (C2) that may only touch allowed metadata paths.
  stage('PERSIST', 'persistindo resumo, evidências e estado');
  for (const t of readPlan(pp.plan).tasks) {
    if (t.status === 'VERIFIED') transition(t.id, 'DONE');
  }
  const finalPlan = readPlan(pp.plan);
  writeFileAtomic(
    pp.verification,
    serializeFrontmatter(
      {
        phase: phase.id,
        verified_at: now().toISOString(),
        commands: evidences.map((e) => ({ command: e.command, exit_code: e.exit_code, duration_ms: e.duration_ms })),
        ui_smoke: uiSmokeNote,
        tested_commit: null,
        evidence_commit: null,
        vcs: ctx.git.status(ctx.projectRoot).isRepo && config.git.commit ? 'git' : 'disabled',
      },
      [
        `# Verification — phase ${phase.id}`,
        '',
        ...evidences.map((e) => `- \`${e.command}\` → exit ${e.exit_code}`),
        '',
        `UI smoke: ${uiSmokeNote}`,
        '',
      ].join('\n'),
    ),
  );
  writeFileAtomic(
    pp.summary,
    serializeFrontmatter(
      { phase: phase.id, completed_at: now().toISOString() },
      [
        `# Summary — phase ${phase.id} (${phase.name})`,
        '',
        ...finalPlan.tasks.map((t) => `- ${t.done ? '✔' : '✘'} ${t.id} ${t.name}`),
        '',
      ].join('\n'),
    ),
  );
  // Requirement completion: DONE only when task, test, review and evidence are
  // all linked. We only reach here after the review approved; the requirement
  // records the tests and the verification evidence explicitly.
  const reqDocFinal = readRequirements(milestone.paths.requirements);
  const hadEvidence = evidences.length > 0;
  for (const r of reqDocFinal.requirements) {
    if (r.phase !== phase.id) continue;
    const coveringTasks = finalPlan.tasks.filter((t) => t.requirement_ids.includes(r.id) && t.status === 'DONE');
    if (coveringTasks.length === 0) {
      // Not implemented by any completed task — never silently mark DONE.
      r.status = 'BLOCKED';
      continue;
    }
    const tests = coveringTasks.flatMap((t) => t.tests);
    r.status = 'DONE';
    r.tests = tests;
    if (tests.length === 0 && !r.no_test_justification) {
      const waived = coveringTasks.every((t) => t.no_execution_justification);
      r.no_test_justification = waived
        ? `Non-executable work (waiver): ${coveringTasks.map((t) => t.no_execution_justification).join('; ')}`
        : 'Verified by phase verification commands (no dedicated test declared in plan).';
    }
    r.evidence = `VERIFICATION.md + REVIEW.md of phase ${phase.id} (${evidences.length} commands${hadEvidence ? ', all exit 0' : ', waived'}; review approved)`;
  }
  writeRequirements(milestone.paths.requirements, reqDocFinal);
  markPhase('DONE', null);
  checkpoint('DONE', `Phase ${phase.id} (${phase.name}) verified.`, {
    task: null,
    last_verified: `phase ${phase.id} @ ${now().toISOString()}`,
    next_step: 'rijo run (next phase) or rijo check',
  });

  // ---- COMMIT: two-commit model without self-reference.
  //   C1 (code commit): source changed within task scopes + all phase state,
  //      with no commit hash recorded anywhere inside it.
  //   verification already ran against exactly this tree.
  //   C2 (evidence commit): ONLY the allowed metadata paths, updated to point
  //      at C1. The C1..C2 range is verified to contain nothing else.
  let commitHash: string | null = null;
  const gitStatus = ctx.git.status(ctx.projectRoot);
  if (config.git.commit && gitStatus.isRepo) {
    stage('COMMIT', 'commit dos arquivos autorizados da fase verificada');
    const sourceDelta = diffSnapshots(phaseBaseline, snapshotFiles(ctx.projectRoot));
    const authorizedSource = sourceDelta.changed.filter((p) => plan.tasks.some((t) => pathInScope(p, t.write_scope)));

    // Pre-existing user edits on the same paths are an explicit conflict —
    // never silently appropriated into a RIJO commit.
    const appropriated = authorizedSource.filter((p) => dirtyAtStart.has(p));
    if (appropriated.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: files had pre-existing local changes before this phase ran.`, [
        `Conflicting paths: ${appropriated.join(', ')}`,
        'Commit or revert your local changes, then re-run the phase.',
      ]);
    }

    const rel = (p: string) => path.relative(ctx.projectRoot, p).split(path.sep).join('/');
    const rijoArtifacts = [
      pp.spec, pp.plan, pp.summary, pp.review, pp.verification,
      milestone.paths.requirements, milestone.paths.roadmap,
      paths.state, paths.manifest, paths.milestonesIndex, paths.stack, paths.decisions,
    ]
      .filter(exists)
      .map(rel);
    const toCommit = [...new Set([...authorizedSource, ...rijoArtifacts])];
    commitHash = ctx.git.commitPaths(ctx.projectRoot, `rijo(${milestone.id}-F${phase.id}): ${phase.name} verified`, toCommit);
    if (!commitHash) {
      return blocked(ctx, `Phase ${phase.id}: code commit (C1) failed while git commits are enabled.`, [
        'The verified artifacts are on disk but the phase commit did not complete.',
      ]);
    }

    // C2: evidence pointing at C1 — only allowed metadata paths may change.
    const { data, body } = parseFrontmatter(readText(pp.verification));
    writeFileAtomic(
      pp.verification,
      serializeFrontmatter({ ...(data as Record<string, unknown>), tested_commit: commitHash, evidence_commit: null }, body),
    );
    markPhase('DONE', commitHash);
    checkpoint('DONE', `Phase ${phase.id} (${phase.name}) verified and committed.`, {
      task: null,
      last_verified: `phase ${phase.id} @ ${now().toISOString()}`,
      last_commit: commitHash,
      next_step: 'rijo run (next phase) or rijo check',
    });
    const allowedEvidencePaths = [pp.verification, milestone.paths.roadmap, paths.state, paths.manifest, paths.milestonesIndex]
      .filter(exists)
      .map(rel);
    const evidenceCommit = ctx.git.commitPaths(ctx.projectRoot, `rijo(${milestone.id}-F${phase.id}): evidence for ${commitHash.slice(0, 12)}`, allowedEvidencePaths);
    if (!evidenceCommit) {
      return blocked(ctx, `Phase ${phase.id}: evidence commit (C2) failed.`, [
        `Code commit ${commitHash} exists but its evidence metadata is uncommitted.`,
      ]);
    }
    // Deterministic check: C1..C2 contains ONLY allowed evidence metadata.
    const rangeFiles = ctx.git.diffNames(ctx.projectRoot, commitHash, evidenceCommit);
    const illegal = rangeFiles.filter((f) => !allowedEvidencePaths.includes(f));
    if (illegal.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: evidence commit touched non-evidence paths.`, illegal);
    }
    // Record the evidence commit inside its own file for auditability (this
    // makes the working file differ from C2 by exactly one known field; it is
    // folded into the NEXT phase's C1, never left dangling as unknown state).
    const after = parseFrontmatter(readText(pp.verification));
    writeFileAtomic(
      pp.verification,
      serializeFrontmatter({ ...(after.data as Record<string, unknown>), evidence_commit: evidenceCommit }, after.body),
    );
    touchManifest(paths, () => {}, now);
    const finalCommit = ctx.git.commitPaths(ctx.projectRoot, `rijo(${milestone.id}-F${phase.id}): evidence sealed`, [rel(pp.verification), rel(paths.manifest)]);
    if (!finalCommit) {
      return blocked(ctx, `Phase ${phase.id}: evidence seal commit failed.`, []);
    }

    // The tree must be clean when the phase ends: nothing RIJO touched — and
    // no canonical .rijo file at all — may remain uncommitted.
    const endStatus = ctx.git.status(ctx.projectRoot);
    const rijoDirty = endStatus.dirtyFiles.filter(
      (f) => f.startsWith('.rijo/') || toCommit.includes(f) || allowedEvidencePaths.includes(f),
    );
    if (rijoDirty.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: tree not clean after commits.`, rijoDirty);
    }
  }

  bus.emit('run.phase_done', {
    status: 'running',
    stage: 'DONE',
    lastCheckpoint: commitHash ?? `phase-${phase.id}`,
    message: `fase ${phase.id} concluída${commitHash ? ` (commit ${commitHash.slice(0, 8)})` : ''}`,
  });
  return completed(ctx, `Phase ${phase.id} (${phase.name}) done${commitHash ? `, commit ${commitHash}` : ''}.`);
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
    objective: spec.objective,
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
  const attempt = prepareAttempt(ctx, repairTask);
  try {
    const res = await dispatch(ctx, attempt.task, { stage: 'EXECUTE' });
    if (!res.ok) {
      return blocked(ctx, `Phase ${phaseId}: repair worker failed.`, [res.summary]);
    }
    attempt.workspace.applyVerifiedPatch();
    return null;
  } catch (err) {
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
    attempt.workspace.discard();
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
