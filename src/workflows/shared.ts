import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { AttemptWorkspace, snapshotTree, diffTrees, discardOrphanWorkspaces } from '../core/workspace.js';
import { reconcileSupervisedTasks } from '../supervisor/recover.js';
import { canonicalBaselineHash } from '../core/manifest.js';
import { reconcileTransactions, type TxnHooks } from '../core/txn.js';
import type { FinalizeHooks } from '../core/finalize.js';
import { reconcileFinalization } from './finalize.js';
import { loadConfig } from '../core/config.js';
import { ProgressBus, consoleSink, newRunId, type ProgressSink } from '../core/progress.js';
import { acquireLock, RECOMMENDED_RENEW_MS } from '../core/locks.js';
import { readState, writeState } from '../core/state.js';
import { SchemaMismatchError, touchManifest } from '../core/manifest.js';
import { ensureSchemaCompatible, MigrationError } from '../core/migrate.js';
import { exists } from '../core/fsx.js';
import type { RijoConfig, SupervisorConfig } from '../core/schemas/index.js';
import type { AgentRunner } from '../agents/runner.js';
import { UnboundAgentRunner } from '../agents/runner.js';
import { AgentTaskSchema, type AgentTask, type AgentTaskDraft, type AgentResult } from '../agents/protocol.js';
import type { ShellRunner } from '../core/commands.js';
import { SystemShellRunner } from '../core/commands.js';
import type { GitOps } from '../core/git.js';
import { SystemGit } from '../core/git.js';
import type { Clock } from '../supervisor/clock.js';
import { defaultExecutor, type TaskExecutor, type SupervisedDispatch } from './executor.js';
import { prepareDispatchedTask, type DispatchRouting } from './routing.js';

export type { DispatchRouting } from './routing.js';

export interface WorkflowContext {
  projectRoot: string;
  paths: RijoPaths;
  config: RijoConfig;
  bus: ProgressBus;
  runner: AgentRunner;
  /** Sole execution authority: every dispatch is supervised through this. */
  executor: TaskExecutor;
  shell: ShellRunner;
  git: GitOps;
  now: () => Date;
  /** Test seam: fault injection at each durable phase-finalization step. */
  finalizeHooks: FinalizeHooks;
}

export interface WorkflowDeps {
  runner?: AgentRunner;
  /** Pluggable execution authority (P0.9 injects a real host controller here). */
  executor?: TaskExecutor;
  /** Override the supervisor policy (test seam: short deadlines / replacements). */
  supervisorConfig?: SupervisorConfig;
  /** Injectable clock for deterministic supervision timing in tests. */
  clock?: Clock;
  shell?: ShellRunner;
  git?: GitOps;
  sink?: ProgressSink;
  now?: () => Date;
  /** test seam: fault injection inside milestone transactions. */
  txnHooks?: TxnHooks;
  /** test seam: fault injection at each durable phase-finalization step. */
  finalizeHooks?: FinalizeHooks;
}

export function createContext(projectRoot: string, deps: WorkflowDeps = {}): WorkflowContext {
  const paths = new RijoPaths(projectRoot);
  const now = deps.now ?? (() => new Date());
  const config = loadConfig(paths);
  const runner = deps.runner ?? new UnboundAgentRunner();
  // The executor is the ONLY path to an agent: dispatch/dispatchBatch never
  // touch the runner directly. The default supervises the in-process runner;
  // a real host controller can be injected (deps.executor) unchanged.
  //
  // A genuinely in-process function call cannot be usefully "replaced" (a
  // deterministic runner returns the same result on retry and a stuck call
  // cannot be interrupted), so the implicit default disables replacement
  // generations — the supervisor still fences a stuck attempt and yields a
  // BLOCKED diagnostic instead of looping. An EXPLICIT supervisorConfig (a
  // test seam exercising replacements / short deadlines) is honored verbatim.
  const supervisorConfig: SupervisorConfig = deps.supervisorConfig ?? {
    ...config.supervisor,
    max_replacements_per_task: 0,
    replacement_backoff_ms: [],
  };
  const executor = deps.executor ?? defaultExecutorFor(runner, supervisorConfig, paths, deps.clock);
  return {
    projectRoot,
    paths,
    config,
    bus: new ProgressBus(paths, newRunId(now), deps.sink ?? consoleSink, now),
    runner,
    executor,
    shell: deps.shell ?? new SystemShellRunner(config.execution),
    git: deps.git ?? new SystemGit(),
    now,
    finalizeHooks: deps.finalizeHooks ?? {},
  };
}

/** Build the default in-process executor, honoring an optional injected clock. */
function defaultExecutorFor(
  runner: AgentRunner,
  supervisorConfig: SupervisorConfig,
  paths: RijoPaths,
  clock?: Clock,
): TaskExecutor {
  return defaultExecutor(runner, supervisorConfig, paths, clock);
}

export class BlockedError extends Error {
  constructor(
    message: string,
    public readonly diagnostic: string,
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}

/**
 * Guard against running against an incompatible on-disk schema. An OLDER
 * schema is migrated in place (backup + deterministic transform) before the
 * workflow proceeds; a NEWER schema blocks — an old build never touches a
 * newer project. Returns a blocked outcome on failure, null when compatible.
 */
export function guardSchema(ctx: WorkflowContext): WorkflowOutcome | null {
  try {
    const report = ensureSchemaCompatible(ctx.paths, ctx.now);
    if (report && report.changed.length > 0) {
      ctx.bus.emit('schema.migrated', {
        message: `schema migrado v${report.from} → v${report.to} (backup em ${report.backupDir})`,
      });
    }
    return null;
  } catch (err) {
    if (err instanceof SchemaMismatchError || err instanceof MigrationError) {
      return blocked(ctx, 'Schema version mismatch.', [err instanceof Error ? err.message : String(err)]);
    }
    throw err;
  }
}

/**
 * Run a workflow body under the runtime lock; renews the lease periodically; always releases.
 * ttlMs/renewMs are test seams (production callers rely on the library defaults).
 */
export async function withLock<T>(
  ctx: WorkflowContext,
  body: () => Promise<T>,
  opts: { ttlMs?: number; renewMs?: number } = {},
): Promise<T> {
  const handle = acquireLock(ctx.paths.lock, ctx.bus.runId, ctx.now, { ttlMs: opts.ttlMs });
  if (handle.reclaimedAttempts.length > 0) {
    ctx.bus.emit(
      'lock.reclaimed',
      { message: `lock reciclado; ${handle.reclaimedAttempts.length} attempt(s) órfão(s) para recovery` },
      { attempts: handle.reclaimedAttempts },
    );
  }
  // Real (non-injected) timers: the lease must keep renewing on wall-clock
  // time regardless of ctx.now, and unref() so it never keeps the process alive.
  const renewTimer = setInterval(() => {
    try {
      handle.renew();
    } catch {
      /* best-effort renewal; a missed tick is recovered by the next one */
    }
  }, opts.renewMs ?? RECOMMENDED_RENEW_MS);
  renewTimer.unref();
  try {
    // Startup reconciliation runs for EVERY workflow, under the lock, before the
    // body observes anything. Order matters:
    //   (a) roll interrupted milestone transactions back/forward;
    //   (b) reconcile crashed supervised tasks (fence stale attempts, resume or
    //       exhaust each per replacement budget) so none can later apply;
    //   (c) discard orphan attempt workspaces left by a crashed run so no stale
    //       copy can re-introduce a discarded attempt's edits.
    const rec = reconcileTransactions(ctx.paths);
    for (const id of rec.rolledBack) {
      ctx.bus.emit('txn.rolled_back', { message: `transação incompleta descartada: ${id}` }, { txn: id });
    }
    for (const id of rec.rolledForward) {
      ctx.bus.emit('txn.rolled_forward', { message: `transação confirmada reaplicada: ${id}` }, { txn: id });
    }

    const recovery = await reconcileSupervisedTasks(ctx.paths, {
      maxReplacements: ctx.config.supervisor.max_replacements_per_task,
    });
    for (const e of recovery.entries) {
      ctx.bus.emit(
        'supervised.recovered',
        { message: `tarefa supervisionada recuperada: ${e.logical_task_id} (${e.from} → ${e.action})` },
        { ...e },
      );
    }

    for (const ws of discardOrphanWorkspaces(ctx.paths.runtimeDir)) {
      ctx.bus.emit('workspace.orphan_discarded', { message: `workspace órfão descartado: ${ws}` }, { workspace: ws });
    }

    // (d) resume an interrupted phase finalization: complete the commit/seal
    // sequence and flip the phase to a durable DONE, or a strict no-op when no
    // finalize marker exists. This runs before the body so the next execution
    // never observes a phase that is DONE-on-disk yet uncommitted.
    await reconcileFinalization(ctx);

    return await body();
  } finally {
    clearInterval(renewTimer);
    handle.release();
  }
}

export interface WorkflowOutcome {
  ok: boolean;
  status: 'completed' | 'blocked' | 'failed';
  message: string;
  details?: string[];
}

/**
 * Route a draft through the deterministic model-tier + expert-profile router,
 * then supervise it. NO draft reaches the executor without routing: the tier
 * is resolved from config.yml and the expert lenses are stamped on the task
 * (embedded into the rendered brief). Every dispatch is supervised — a durable
 * TaskRecord is created before any host starts and no stale/duplicate/fenced
 * result can ever be applied.
 */
export async function dispatch(
  ctx: WorkflowContext,
  task: AgentTaskDraft,
  routing: DispatchRouting = {},
  options: { prepareReplacement?: SupervisedDispatch['prepareReplacement'] } = {},
): Promise<AgentResult> {
  const routed = prepareDispatchedTask(ctx.config, task, routing);
  const full: AgentTask = AgentTaskSchema.parse(routed);
  return ctx.executor.run({
    task: full,
    role: full.role,
    ...(options.prepareReplacement ? { prepareReplacement: options.prepareReplacement } : {}),
  });
}

/**
 * Supervise a batch with independent per-task supervision. A per-item routing
 * factory lets each draft carry its own stage/tags; omit it to route every
 * draft by role default.
 */
export async function dispatchBatch(
  ctx: WorkflowContext,
  tasks: AgentTaskDraft[],
  max?: number,
  routing?: (task: AgentTaskDraft, index: number) => DispatchRouting,
  replacement?: (task: AgentTaskDraft, index: number) => SupervisedDispatch['prepareReplacement'],
): Promise<AgentResult[]> {
  const reqs: SupervisedDispatch[] = tasks.map((t, i) => {
    const routed = prepareDispatchedTask(ctx.config, t, routing ? routing(t, i) : {});
    const full: AgentTask = AgentTaskSchema.parse(routed);
    const prep = replacement?.(t, i);
    return { task: full, role: full.role, ...(prep ? { prepareReplacement: prep } : {}) };
  });
  return ctx.executor.runBatch(reqs, max ?? ctx.config.limits.max_parallel_agents);
}

/** Attempt bundle: the dispatched task plus its isolated workspace. */
export interface Attempt {
  task: AgentTask;
  workspace: AttemptWorkspace;
}

/**
 * Prepare an isolated attempt: create the workspace, remap the brief's file
 * references into it and stamp the canonical baseline. The agent only ever
 * sees (and writes) the workspace copy.
 */
export function prepareAttempt(
  ctx: WorkflowContext,
  task: AgentTaskDraft,
  opts: { canonicalWriteScope?: string[] } = {},
): Attempt {
  const full = AgentTaskSchema.parse(task);
  const baseline = canonicalBaselineHash(ctx.paths);
  const workspace = AttemptWorkspace.create(ctx.projectRoot, {
    taskId: full.id,
    writeScope: full.write_scope,
    canonicalWriteScope: opts.canonicalWriteScope,
    baselineCommit: ctx.git.status(ctx.projectRoot).isRepo ? ctx.git.headCommit(ctx.projectRoot) : null,
    baselineCanonicalHash: baseline,
  });
  const remap = (p: string) => {
    const rel = path.relative(ctx.projectRoot, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
    return path.join(workspace.root, rel);
  };
  const remapped: AgentTask = {
    ...full,
    canonical_files: full.canonical_files.map(remap),
    code_files: full.code_files.map(remap),
    workspace: { id: workspace.id, root: workspace.root },
    canonical_baseline: baseline,
  };
  return { task: remapped, workspace };
}

/**
 * An attempt handle whose workspace is REBUILT for every replacement
 * generation: the supervisor calls `prepareReplacement` after fencing a failed
 * generation, and the handle swaps `attempt` to a brand-new routed task in a
 * brand-new isolated workspace. The caller always validates/applies
 * `handle.attempt` — the winning generation — never a fenced one.
 */
export interface ReplaceableAttempt {
  /** The attempt of the LATEST generation (the one applied on success). */
  attempt: Attempt;
  /** Factory handed to the executor: fresh routed task + fresh workspace per replacement. */
  prepareReplacement: NonNullable<SupervisedDispatch['prepareReplacement']>;
}

export function replaceableAttempt(
  ctx: WorkflowContext,
  draft: AgentTaskDraft,
  opts: { canonicalWriteScope?: string[] } = {},
  routing: DispatchRouting = {},
): ReplaceableAttempt {
  const handle: ReplaceableAttempt = {
    attempt: prepareAttempt(ctx, draft, opts),
    prepareReplacement: (_generation, _previousFailure) => {
      // A fenced generation's workspace is never reused. Re-route the ORIGINAL
      // draft (same deterministic profile routing as the first dispatch) and
      // isolate it in a brand-new workspace against the current baseline.
      const routed = prepareDispatchedTask(ctx.config, draft, routing);
      const fresh = prepareAttempt(ctx, routed, opts);
      handle.attempt = fresh;
      return {
        task: fresh.task,
        dispose: () => {
          // Called only when THIS generation is abandoned (replaced again,
          // exhausted or externally stopped) — never after success.
          try {
            fresh.workspace.discard();
          } catch {
            /* already discarded */
          }
        },
      };
    },
  };
  return handle;
}

/**
 * A read-only dispatch (reviewer/researcher/planner returning a payload):
 * no workspace, empty write scope, and the controlled checkout is verified
 * untouched afterwards — a "read-only" agent that wrote anything is a hard
 * violation, not a warning.
 */
export async function dispatchReadOnly(
  ctx: WorkflowContext,
  task: AgentTaskDraft,
  routing: DispatchRouting = {},
): Promise<{ result: AgentResult; violation: string[] }> {
  const before = snapshotTree(ctx.projectRoot);
  const result = await dispatch(
    ctx,
    { ...task, write_scope: [], workspace: null, canonical_baseline: canonicalBaselineHash(ctx.paths) },
    routing,
  );
  const delta = diffTrees(before, snapshotTree(ctx.projectRoot));
  return { result, violation: delta.changed };
}

export function blocked(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  ctx.bus.emit('workflow.blocked', { status: 'blocked', message }, { details });
  // Persist the blocked state durably ONLY when a run is actually in progress
  // (a phase is active) — so a later `rijo --status` and the next run see the
  // true situation. Pure input-validation refusals (no project, wrong flags,
  // re-init without --next) must stay fully non-destructive and never touch state.
  try {
    if (exists(ctx.paths.state)) {
      const prev = readState(ctx.paths);
      if (prev && prev.phase !== null) {
        writeState(
          ctx.paths,
          { ...prev, blocked: true, blocked_reason: message, updated_at: ctx.now().toISOString() },
          `BLOCKED: ${message}`,
        );
        // refresh manifest hashes so this state write is not later seen as drift
        touchManifest(ctx.paths, () => {}, ctx.now);
      }
    }
  } catch {
    /* never let checkpoint persistence mask the original blocker */
  }
  return { ok: false, status: 'blocked', message, details };
}

export function failed(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  ctx.bus.emit('workflow.failed', { status: 'failed', message }, { details });
  return { ok: false, status: 'failed', message, details };
}

export function completed(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  ctx.bus.emit('workflow.completed', { status: 'completed', message }, { details });
  return { ok: true, status: 'completed', message, details };
}
