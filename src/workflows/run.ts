import * as path from 'node:path';
import { z } from 'zod';
import { exists, readText, readTextIfExists, writeFileAtomic, ensureDir } from '../core/fsx.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { phasePaths, type PhasePaths } from '../core/paths.js';
import { readState } from '../core/state.js';
import { touchManifest, canonicalBaselineHash } from '../core/manifest.js';
import { activeMilestone, type MilestoneRef } from '../core/milestones.js';
import { readRequirements, readRoadmap, writeRoadmap, nextPhase, type RoadmapDoc } from '../core/roadmap.js';
import { readPlan, writePlan, lintPlan, setTaskStatus, parallelGroups } from '../core/plan.js';
import { validateStateIntegrity } from '../core/traceability.js';
import { checkContextBudget } from '../core/contextBudget.js';
import { snapshotFiles, diffSnapshots, type FileSnapshot } from '../core/scope.js';
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
import { PhasePlanSchema, ReviewFindingTypeSchema, FindingSeveritySchema, looseBool, type RoadmapPhase, type PhasePlan, type TaskStatus } from '../core/schemas/index.js';
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
  isWorkflowCancellation,
  type ReplaceableAttempt,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';
import { inferSecurityTag, inferHighRisk } from './routing.js';
import { stageFinalization } from './finalize.js';

export interface RunOptions {
  /** undefined = resume from STATE.md; 'next' = next ready phase; 'all' = every phase; 'NN' = specific phase */
  target?: string;
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
    const spec = replaceableAttempt(ctx, specTask, { canonicalWriteScope: [specRel] }, { stage: 'SPEC_READY' });
    const res = await dispatch(ctx, spec.attempt.task, { stage: 'SPEC_READY' }, { prepareReplacement: spec.prepareReplacement });
    try {
      if (!res.ok || !exists(path.join(spec.attempt.workspace.root, specRel))) {
        return blocked(ctx, `Phase ${phase.id}: spec generation failed.`, [res.summary]);
      }
      spec.attempt.workspace.applyVerifiedPatch();
      touchManifest(paths, () => {}, now);
    } catch (err) {
      return blocked(ctx, `Phase ${phase.id}: spec generation violated workspace boundaries.`, [String((err as Error).message)]);
    } finally {
      spec.attempt.workspace.discard();
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
        objective: `Produce the execution plan for phase ${phase.id}: between 2 and 4 tasks, exact files or code regions, dependencies, per-worker write scope, tests and expected evidence, parallel flag only for independent tasks with disjoint write scopes. Set tdd=true for testable behavior. EVERY task must CREATE or EDIT at least one concrete source/test file — its "files" and "write_scope" arrays must each name at least one real path. Do NOT emit a verification-only, evidence-only, or "run the tests" task: the framework runs verification and records evidence itself; a task that writes no file is invalid.`,
        canonical_files: [paths.rules, pp.spec, milestone.paths.requirements].filter(exists),
        code_files: [],
        write_scope: [],
        acceptance_criteria: ['2-4 tasks', 'every task writes at least one concrete file (non-empty files[] and write_scope[])', 'every task has requirement IDs or technical justification', 'write scopes are exact'],
        verification_commands: [],
        return_format:
          'JSON payload matching PhasePlan: {phase, tasks:[{id:"T01", name, requirement_ids[], technical_justification, files[/*>=1 real path*/], write_scope[/*>=1 real path*/], depends_on[], parallel, tdd, tests[], evidence_expected}]}. Never leave files[] or write_scope[] empty.',
        notes: reviewNotes.length ? `Previous review issues to address:\n${reviewNotes.join('\n')}` : '',
        workspace: null,
        canonical_baseline: null,
      };
      const { result: res, violation } = await dispatchReadOnly(ctx, planTask, { stage: 'PLAN' });
      if (violation.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: planner (read-only) modified the checkout.`, violation);
      }
      // A planner dispatch that the host could not deliver (ok:false — e.g. an
      // intermittent headless read-only glitch where the model produced no
      // parseable result) is RECOVERABLE, not fatal: re-plan within the same
      // plan_revisions budget rather than abandoning the phase on a transient
      // host blip. Only an exhausted budget blocks.
      if (!res.ok) {
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
      const parsed = PhasePlanSchema.safeParse(res.payload);
      if (!parsed.success) {
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
    // An ATTEMPT failure (ok:false — e.g. an intermittent headless read-only
    // glitch) is RECOVERABLE: re-run the plan/review cycle within the
    // plan_revisions budget rather than abandoning the phase on a transient blip.
    if (!reviewRes.ok) {
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
    reviewNotes = review.success
      ? blockingFindings.map((f) => `${f.type}/${f.severity}: ${f.description}`)
      : [`Reviewer verdict (unstructured): ${reviewRes.summary}`];
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
      const workerTask: AgentTaskDraft = {
        id: `exec-${phase.id}-${t.id}`,
        role: 'worker',
        objective: `Implement task ${t.id}: ${t.name}. ${t.tdd ? 'Follow TDD: write a failing test (RED), implement (GREEN), refactor. ' : ''}Work ONLY inside your isolated workspace; do not modify files outside your write scope; if you need to, stop and request a new allocation. You have NO shell — do NOT run the verification commands, tests, npm, git or any other process yourself; the framework runs verification after you finish. Once the code is written into your write scope, return ok:true; report ok:false ONLY if you genuinely could not implement the change (never merely because you could not run the tests).`,
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
    stage('EXECUTE', `executando ${pending.map((t) => t.id).join('+')}`, {});
    bus.emit('run.task_start', {
      stage: 'EXECUTE',
      task: { id: pending[0]!.id, index: taskIdx, total: totalTasks, name: pending[0]!.name },
      agent: { role: 'worker', id: attempts[0]!.attempt.task.id },
      message: pending.map((t) => t.name).join(' | '),
    });

    const discardAll = () => attempts.forEach((a) => a.attempt.workspace.discard());
    let results: AgentResult[];
    try {
      results = await dispatchBatch(
        ctx,
        attempts.map((a) => a.attempt.task),
        undefined,
        (task) => routingFor(task),
        (_task, i) => attempts[i]!.prepareReplacement,
      );
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
    // An ATTEMPT failure (ok:false — e.g. an intermittent headless read-only
    // glitch) is RECOVERABLE: the code is already implemented and verified, so
    // simply re-run the verify+review cycle within the review_loops budget
    // rather than discarding a green phase on a transient review blip.
    // A COMPLETED review whose verdict is not in schema is NOT auto-approval
    // (that would silently drop the gate): treat it as an unresolved review with
    // the reviewer's summary as the finding, and run the bounded repair loop
    // below — it only blocks once the review_loops budget is exhausted.
    if (!crRes.ok) {
      if (isWorkflowCancellation(crRes) || reviewLoops >= config.limits.review_loops) {
        return blocked(ctx, `Phase ${phase.id}: code review failed to produce a verdict after ${config.limits.review_loops} cycles.`, [crRes.summary]);
      }
      reviewLoops++;
      continue;
    }
    const cr = ReviewPayloadSchema.safeParse(crRes.payload);
    if (!cr.success) {
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
      continue;
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
  stage('PERSIST', 'persistindo resumo, evidências e estado');
  return stageFinalization(ctx, {
    milestone,
    phase,
    pp,
    plan,
    evidences,
    uiSmokeNote,
    phaseBaseline,
    dirtyAtStart,
  });
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
    objective: `${spec.objective} You have NO shell — do NOT run the verification commands, tests, npm, git or any other process yourself; the framework re-runs verification after you finish. Edit the code in your write scope and return ok:true; report ok:false ONLY if you genuinely could not make the change (never merely because you could not run the tests).`,
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
  try {
    const res = await dispatch(ctx, handle.attempt.task, { stage: 'EXECUTE' }, { prepareReplacement: handle.prepareReplacement });
    if (!res.ok) {
      return blocked(ctx, `Phase ${phaseId}: repair worker failed.`, [res.summary]);
    }
    handle.attempt.workspace.applyVerifiedPatch();
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
    handle.attempt.workspace.discard();
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
