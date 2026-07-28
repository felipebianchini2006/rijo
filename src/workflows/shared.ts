import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { AttemptWorkspace, snapshotTree, diffTrees, discardOrphanWorkspaces } from '../core/workspace.js';
import { reconcileSupervisedTasks } from '../supervisor/recover.js';
import { canonicalBaselineHash } from '../core/manifest.js';
import { reconcileTransactions, type TxnHooks } from '../core/txn.js';
import type { FinalizeHooks } from '../core/finalize.js';
import { reconcileFinalization } from './finalize.js';
import { loadConfig } from '../core/config.js';
import {
  ProgressBus,
  consoleSink,
  newRunId,
  type DurableProgressRecorder,
  type ProgressSink,
} from '../core/progress.js';
import { acquireLock, RECOMMENDED_RENEW_MS } from '../core/locks.js';
import { readState, writeState } from '../core/state.js';
import { SchemaMismatchError, touchManifest } from '../core/manifest.js';
import { ensureSchemaCompatible, MigrationError } from '../core/migrate.js';
import { exists, readJsonIfExists } from '../core/fsx.js';
import { TaskRecordSchema, type RijoConfig, type SupervisorConfig } from '../core/schemas/index.js';
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
import {
  commitPendingDecision,
  prepareDecision,
  reconcileDecisionCommits,
  type DecisionCommitHooks,
  type PendingDecision,
} from '../core/decisions.js';
import { TaskStore } from '../supervisor/store.js';
import {
  createWorkflowEpoch,
  WorkflowEpochSchema,
  type WorkflowEpoch,
} from '../core/workflow-epoch.js';

export type { DispatchRouting } from './routing.js';

export type DurableTerminalStatus = 'READY' | 'NOT_READY' | 'BLOCKED';

export interface DurableRunBinding {
  runId: string;
  disposition: 'created' | 'resumed' | 'plan_mismatch';
  planHash: string | null;
  existingPlanHash?: string | null;
}

/**
 * Workflow-facing port of DurableStateEngine. Workflows know nothing about
 * SQLite: they provide identities and lifecycle boundaries while the engine
 * owns transactions, events, outbox projections, snapshots and rebuild.
 */
export interface DurableWorkflowEngine extends DurableProgressRecorder {
  initialize(): Promise<void>;
  recover(): Promise<void>;
  beginOrResumeRun(input: {
    requestedRunId: string;
    /** Canonical plan source, when the command is `new`; adapters may hash it internally. */
    plan?: string;
    planHash?: string;
    next?: boolean;
    host?: string;
    startedCommit?: string | null;
  }): Promise<DurableRunBinding>;
  createCheckpoint(input: { reason: string; commit?: string | null }): Promise<void>;
  createSnapshot(input: { reason: string }): Promise<void>;
  markTerminal(input: {
    status: DurableTerminalStatus;
    reason: string;
    commit?: string | null;
  }): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

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
  /** Effective CLI host after resolving `--host` over config defaults. */
  hostProvider: RijoConfig['host']['provider'];
  durable: DurableWorkflowEngine | null;
  durableRun: DurableRunBinding | null;
  /** One durable identity for the complete authorized workflow operation. */
  workflowEpoch: WorkflowEpoch;
  /** Same-context production gate used by autonomous run completion. */
  finalCheck?: (ctx: WorkflowContext, opts: { production?: boolean; fix?: boolean }) => Promise<WorkflowOutcome>;
  /** Crash-injection and durability hooks shared by canonical transactions, including codebase-map promotion. */
  txnHooks: TxnHooks;
  /** Test seam: fault injection at each durable phase-finalization step. */
  finalizeHooks: FinalizeHooks;
  /** Result-scoped proposals awaiting workflow-specific approval. */
  openDecisionEnvelopes: Set<ValidatedAgentEnvelope>;
  decisionHooks: DecisionCommitHooks;
  planHooks: {
    afterInvalidated?: () => void;
    afterPlanWritten?: () => void;
    afterReplanned?: () => void;
  };
  /** Test seam for a crash after source apply and before task projection. */
  taskPatchHooks: {
    afterApplied?: (transactionId: string, taskId: string) => void;
  };
  /** Test seam for a crash after a durable phase gate receipt. */
  phaseGateHooks: {
    afterAcceptedReview?: () => void;
    afterUiSmokeReceipt?: () => void;
  };
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
  /** Effective host selected by an embedding CLI boundary. */
  hostProvider?: RijoConfig['host']['provider'];
  /** Durable engine injection. Production wiring supplies the SQLite-backed implementation. */
  durable?: DurableWorkflowEngine | null;
  /** Programmatic seam; autonomous CLI uses checkCore in the same lock. */
  finalCheck?: WorkflowContext['finalCheck'];
  /** test seam: fault injection inside milestone transactions. */
  txnHooks?: TxnHooks;
  /** test seam: fault injection at each durable phase-finalization step. */
  finalizeHooks?: FinalizeHooks;
  /** test seam: fault injection across decision persistence phases. */
  decisionHooks?: DecisionCommitHooks;
  /** test seam: fault injection across durable plan invalidation/re-planning. */
  planHooks?: WorkflowContext['planHooks'];
  /** test seam: fault injection between task patch apply and task projection. */
  taskPatchHooks?: WorkflowContext['taskPatchHooks'];
  /** test seam: fault injection after durable phase gate receipts. */
  phaseGateHooks?: WorkflowContext['phaseGateHooks'];
  /** Authorized workflow identity. Native helpers and resume must reuse it. */
  workflowEpoch?: WorkflowEpoch;
}

export function createContext(projectRoot: string, deps: WorkflowDeps = {}): WorkflowContext {
  const paths = new RijoPaths(projectRoot);
  const now = deps.now ?? (() => new Date());
  const config = loadConfig(paths);
  const runner = deps.runner ?? new UnboundAgentRunner();
  const workflowEpoch = WorkflowEpochSchema.parse(
    deps.workflowEpoch ??
      (runner as AgentRunner & { workflowEpoch?: WorkflowEpoch }).workflowEpoch ??
      createWorkflowEpoch(),
  );
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
  const executor =
    deps.executor ??
    defaultExecutorFor(
      runner,
      supervisorConfig,
      paths,
      workflowEpoch,
      deps.clock,
    );
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
    hostProvider: deps.hostProvider ?? config.host.provider,
    durable: deps.durable ?? null,
    durableRun: null,
    workflowEpoch,
    ...(deps.finalCheck ? { finalCheck: deps.finalCheck } : {}),
    txnHooks: deps.txnHooks ?? {},
    finalizeHooks: deps.finalizeHooks ?? {},
    openDecisionEnvelopes: new Set(),
    decisionHooks: deps.decisionHooks ?? {},
    planHooks: deps.planHooks ?? {},
    taskPatchHooks: deps.taskPatchHooks ?? {},
    phaseGateHooks: deps.phaseGateHooks ?? {},
  };
}

/** Build the default in-process executor, honoring an optional injected clock. */
function defaultExecutorFor(
  runner: AgentRunner,
  supervisorConfig: SupervisorConfig,
  paths: RijoPaths,
  workflowEpoch: WorkflowEpoch,
  clock?: Clock,
): TaskExecutor {
  return defaultExecutor(runner, supervisorConfig, paths, workflowEpoch, clock);
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
  opts: {
    ttlMs?: number;
    renewMs?: number;
    run?: { plan?: string; planHash?: string; next?: boolean; host?: string };
    terminal?: boolean;
  } = {},
): Promise<T> {
  const handle = acquireLock(ctx.paths.lock, ctx.bus.runId, ctx.now, { ttlMs: opts.ttlMs });
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
  let durableInitialized = false;
  try {
    if (ctx.durable) {
      // Set before awaiting so a partially opened driver is still given a
      // deterministic close opportunity when initialize() rejects.
      durableInitialized = true;
      await ctx.durable.initialize();
      await ctx.durable.recover();
      ctx.durableRun = await ctx.durable.beginOrResumeRun({
        requestedRunId: ctx.bus.runId,
        ...(opts.run?.plan !== undefined ? { plan: opts.run.plan } : {}),
        ...(opts.run?.planHash ? { planHash: opts.run.planHash } : {}),
        ...(opts.run?.next !== undefined ? { next: opts.run.next } : {}),
        host: opts.run?.host ?? ctx.hostProvider,
        startedCommit: ctx.git.headCommit(ctx.projectRoot),
      });
      // A changed plan without --next is a read-only refusal. Do not attach the
      // bus to the prior run or write a BLOCKED event into somebody else's
      // ledger; the caller reports the mismatch without mutating that run.
      if (ctx.durableRun.disposition !== 'plan_mismatch') {
        ctx.bus.attachDurable(ctx.durable, ctx.durableRun.runId);
      } else {
        // A plan mismatch is an input refusal, not startup recovery. Even
        // legacy recovery can roll transactions forward, reconcile attempts,
        // delete orphan workspaces or finalize a phase; none of those writes
        // may happen while deciding whether this command owns the active run.
        return await body();
      }
    }
    if (handle.reclaimedAttempts.length > 0) {
      ctx.bus.emit(
        'lock.reclaimed',
        { message: `Reclaimed the lock. Recover ${handle.reclaimedAttempts.length} orphaned attempt(s).` },
        { attempts: handle.reclaimedAttempts },
      );
    }
    // Startup reconciliation runs for EVERY workflow, under the lock, before the
    // body observes anything. Order matters:
    //   (a) roll interrupted milestone transactions back/forward;
    //   (b) reconcile crashed supervised tasks (fence stale attempts, resume or
    //       exhaust each per replacement budget) so none can later apply;
    //   (c) discard orphan attempt workspaces left by a crashed run so no stale
    //       copy can re-introduce a discarded attempt's edits.
    const rec = reconcileTransactions(ctx.paths);
    for (const id of rec.rolledBack) {
      ctx.bus.emit('txn.rolled_back', { message: `Discarded the incomplete transaction: ${id}.` }, { txn: id });
    }
    for (const id of rec.rolledForward) {
      ctx.bus.emit('txn.rolled_forward', { message: `Reapplied the committed transaction: ${id}.` }, { txn: id });
    }
    for (const key of reconcileDecisionCommits(ctx.paths, ctx.config.decisions, ctx.now)) {
      ctx.bus.emit('decision.reconciled', {
        message: `Recovered transactional decision: ${key.slice(0, 12)}.`,
      });
    }

    const recovery = await reconcileSupervisedTasks(ctx.paths, {
      maxReplacements: ctx.config.supervisor.max_replacements_per_task,
    });
    for (const e of recovery.entries) {
      ctx.bus.emit(
        'supervised.recovered',
        { message: `Recovered supervised task: ${e.logical_task_id} (${e.from} → ${e.action}).` },
        { ...e },
      );
    }

    const activeWorkspaceIds = new Set(
      new TaskStore(ctx.paths)
        .listNonTerminal()
        .flatMap((record) => (record.workspace_id === null ? [] : [record.workspace_id])),
    );
    for (const ws of discardOrphanWorkspaces(ctx.paths.runtimeDir, activeWorkspaceIds)) {
      ctx.bus.emit('workspace.orphan_discarded', { message: `Discarded the orphaned workspace: ${ws}.` }, { workspace: ws });
    }

    // (d) resume an interrupted phase finalization: complete the commit/seal
    // sequence and flip the phase to a durable DONE, or a strict no-op when no
    // finalize marker exists. This runs before the body so the next execution
    // never observes a phase that is DONE-on-disk yet uncommitted.
    await reconcileFinalization(ctx);

    const result = await body();
    if (
      ctx.durable &&
      opts.terminal &&
      ctx.durableRun?.disposition !== 'plan_mismatch' &&
      isWorkflowOutcome(result)
    ) {
      await persistDurableTerminal(ctx, result);
    }
    commitPortableDurableArtifacts(ctx, 'workflow event journal');
    return result;
  } finally {
    clearInterval(renewTimer);
    try {
      if (ctx.durable && durableInitialized) {
        try {
          await ctx.bus.flushDurable();
          await ctx.durable.flush();
          commitPortableDurableArtifacts(ctx, 'workflow projection flush');
        } finally {
          await ctx.durable.close();
        }
      }
    } finally {
      handle.release();
    }
  }
}

function isWorkflowOutcome(value: unknown): value is WorkflowOutcome {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkflowOutcome>;
  return typeof candidate.ok === 'boolean' && ['completed', 'blocked', 'failed'].includes(candidate.status ?? '');
}

function terminalStatus(outcome: WorkflowOutcome): DurableTerminalStatus {
  const text = `${outcome.message}\n${(outcome.details ?? []).join('\n')}`;
  if (outcome.ok && /\bREADY\b/i.test(text) && !/\bNOT_READY\b/i.test(text)) return 'READY';
  if (/\bNOT_READY\b/i.test(text) || outcome.status === 'failed') return 'NOT_READY';
  return 'BLOCKED';
}

async function persistDurableTerminal(ctx: WorkflowContext, outcome: WorkflowOutcome): Promise<void> {
  if (!ctx.durable) return;
  const status = terminalStatus(outcome);
  await ctx.durable.markTerminal({
    status,
    reason: outcome.message,
    commit: ctx.git.headCommit(ctx.projectRoot),
  });
  // Snapshot after the terminal transaction so it necessarily contains the
  // run.ready/run.not_ready/run.blocked event and terminal run projection.
  await ctx.durable.createSnapshot({ reason: `terminal:${status}` });
  commitPortableDurableArtifacts(ctx, `terminal ${status}`);
}

/** Durable checkpoint/snapshot boundary shared by task, phase and milestone flows. */
export async function durableCheckpoint(
  ctx: WorkflowContext,
  reason: string,
  opts: { commit?: string | null; checkpoint?: boolean; snapshot?: boolean } = {},
): Promise<void> {
  if (!ctx.durable) return;
  await ctx.bus.flushDurable();
  if (opts.checkpoint !== false) {
    await ctx.durable.createCheckpoint({ reason, commit: opts.commit ?? ctx.git.headCommit(ctx.projectRoot) });
  }
  if (opts.snapshot !== false) await ctx.durable.createSnapshot({ reason });
  commitPortableDurableArtifacts(ctx, reason);
}

export function commitPortableDurableArtifacts(ctx: WorkflowContext, reason: string): void {
  if (!ctx.config.git.commit) return;
  if (!ctx.git) return;
  const status = ctx.git.status(ctx.projectRoot);
  if (!status.isRepo) return;
  const portable = status.dirtyFiles.filter(
    (file) =>
      file === '.rijo/.gitignore' ||
      file === '.rijo/events.jsonl' ||
      file.startsWith('.rijo/ledger/') ||
      file.startsWith('.rijo/state/migrations/'),
  );
  if (portable.length === 0) return;
  const commit = ctx.git.commitPaths(
    ctx.projectRoot,
    `rijo(state): ${reason}`,
    portable,
  );
  if (!commit) {
    throw new BlockedError(
      `Durable checkpoint ${reason} could not be committed.`,
      `Portable ledger paths remain dirty: ${portable.join(', ')}`,
    );
  }
}

export interface WorkflowOutcome {
  ok: boolean;
  status: 'completed' | 'not_ready' | 'blocked' | 'failed';
  message: string;
  details?: string[];
}

/** Identify the native bridge pause that waits for a host subagent result. */
export function isNativeResultRequired(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NATIVE_RESULT_REQUIRED:');
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
  options: {
    prepareReplacement?: SupervisedDispatch['prepareReplacement'];
    replaceAfterValidationFailure?: SupervisedDispatch['replaceAfterValidationFailure'];
  } = {},
): Promise<ValidatedAgentEnvelope> {
  const routed = prepareDispatchedTask(ctx.config, task, routing);
  const full: AgentTask = AgentTaskSchema.parse(routed);
  const result = await ctx.executor.run({
    task: full,
    role: full.role,
    ...(options.prepareReplacement ? { prepareReplacement: options.prepareReplacement } : {}),
    ...(options.replaceAfterValidationFailure
      ? { replaceAfterValidationFailure: options.replaceAfterValidationFailure }
      : {}),
  });
  if (result.summary.includes('native result bundle has no result for task')) {
    throw new Error(
      `NATIVE_RESULT_REQUIRED: ${result.summary} Read the exported native request and run the helper again.`,
    );
  }
  return validateAgentDecisions(ctx, result);
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
  validationReplacement?: (
    task: AgentTaskDraft,
    index: number,
  ) => SupervisedDispatch['replaceAfterValidationFailure'],
): Promise<ValidatedAgentEnvelope[]> {
  const reqs: SupervisedDispatch[] = tasks.map((t, i) => {
    const routed = prepareDispatchedTask(ctx.config, t, routing ? routing(t, i) : {});
    const full: AgentTask = AgentTaskSchema.parse(routed);
    const prep = replacement?.(t, i);
    const validation = validationReplacement?.(t, i);
    return {
      task: full,
      role: full.role,
      ...(prep ? { prepareReplacement: prep } : {}),
      ...(validation ? { replaceAfterValidationFailure: validation } : {}),
    };
  });
  const results = await ctx.executor.runBatch(reqs, max ?? ctx.config.limits.max_parallel_agents);
  const pendingNativeResult = results.find((result) =>
    result.summary.includes('native result bundle has no result for task'),
  );
  if (pendingNativeResult) {
    throw new Error(
      `NATIVE_RESULT_REQUIRED: ${pendingNativeResult.summary} Read the exported native request and run the helper again.`,
    );
  }
  return results.map((result) => validateAgentDecisions(ctx, result));
}

export type ValidatedAgentEnvelope = AgentResult & {
  result: AgentResult;
  pending_decisions: PendingDecision[];
  dispatch_id: string;
  attempt_id: string;
  generation: number;
  lease_id: string;
  decision_state: 'PENDING' | 'COMMITTED' | 'DISCARDED';
};

export function validateAgentDecisions(ctx: WorkflowContext, result: AgentResult): ValidatedAgentEnvelope {
  const attemptId = result.attempt_id ?? `unsupervised-${result.task_id}`;
  const generation = result.generation ?? 1;
  const leaseId = result.lease_id ?? `unsupervised-${result.task_id}`;
  const pending: PendingDecision[] = [];
  let validatedResult = result;
  for (const raw of result.decision_proposals ?? []) {
    try {
      const prepared = prepareDecision(
        ctx.paths,
        ctx.config.decisions,
        raw,
        { task_id: result.task_id, attempt_id: attemptId, generation },
        ctx.now,
      );
      if ('status' in prepared && prepared.status === 'BLOCKED') {
        validatedResult = {
          ...result,
          ok: false,
          summary: `BLOCKED (${prepared.category}): ${prepared.missing_fact}. ${prepared.question}`,
        };
        pending.length = 0;
        break;
      }
      pending.push(prepared as PendingDecision);
    } catch (error) {
      validatedResult = {
        ...result,
        ok: false,
        summary: `Decision proposal rejected by core: ${error instanceof Error ? error.message : String(error)}`,
      };
      pending.length = 0;
      break;
    }
  }
  const envelope: ValidatedAgentEnvelope = {
    ...validatedResult,
    result: validatedResult,
    pending_decisions: pending,
    dispatch_id: `${result.task_id}:${attemptId}:${generation}`,
    attempt_id: attemptId,
    generation,
    lease_id: leaseId,
    decision_state: 'PENDING',
  };
  ctx.openDecisionEnvelopes.add(envelope);
  return envelope;
}

export function commitDecisionProposals(ctx: WorkflowContext, envelope: ValidatedAgentEnvelope): void {
  if (envelope.decision_state === 'COMMITTED') return;
  if (envelope.decision_state === 'DISCARDED') {
    throw new Error(`Dispatch ${envelope.dispatch_id}: discarded decisions cannot be committed`);
  }
  const taskFile = path.join(
    ctx.paths.runtimeDir,
    'tasks',
    `${envelope.task_id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
  );
  const current = TaskRecordSchema.safeParse(readJsonIfExists<unknown>(taskFile));
  if (
    !current.success ||
    envelope.workflow_epoch !== ctx.workflowEpoch ||
    current.data.workflow_epoch !== ctx.workflowEpoch ||
    current.data.workflow_epoch !== envelope.workflow_epoch ||
    current.data.logical_task_id !== envelope.task_id ||
    current.data.state !== 'SUCCEEDED' ||
    current.data.attempt_id !== envelope.attempt_id ||
    current.data.generation !== envelope.generation ||
    current.data.lease_id !== envelope.lease_id ||
    current.data.revoked_leases.includes(envelope.lease_id)
  ) {
    discardDecisionProposals(ctx, envelope);
    throw new Error(
      `Dispatch ${envelope.dispatch_id}: missing, stale or revoked, or cross-epoch result decisions were discarded`,
    );
  }
  for (const pending of envelope.pending_decisions) {
    const outcome = commitPendingDecision(
      ctx.paths,
      ctx.config.decisions,
      pending,
      ctx.now,
      ctx.decisionHooks,
    );
    ctx.bus.emit('decision.approved', {
      message: `Decision ${pending.proposal.id} approved.`,
    }, {
      proposal: pending.proposal,
      attempt_id: pending.attempt_id,
      generation: pending.generation,
      idempotency_key: pending.idempotency_key,
      materialized: outcome.status === 'DECIDED' && Boolean(outcome.record),
    });
  }
  envelope.decision_state = 'COMMITTED';
  ctx.openDecisionEnvelopes.delete(envelope);
}

export function discardDecisionProposals(ctx: WorkflowContext, envelope: ValidatedAgentEnvelope): void {
  if (envelope.decision_state === 'COMMITTED') return;
  envelope.pending_decisions.length = 0;
  envelope.decision_state = 'DISCARDED';
  ctx.openDecisionEnvelopes.delete(envelope);
}

function discardAllDecisionProposals(ctx: WorkflowContext): void {
  for (const envelope of [...ctx.openDecisionEnvelopes]) discardDecisionProposals(ctx, envelope);
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
      // The generation being replaced is abandoned (fenced/terminated): discard
      // ITS workspace now so no orphan copy of a failed attempt survives on disk
      // — the supervisor only disposes replacement (gen>1) resources it created,
      // so the ORIGINAL (gen-1) workspace would otherwise leak until the next
      // run's orphan sweep. A fenced generation's workspace is never reused.
      try {
        handle.attempt.workspace.discard();
      } catch {
        /* already discarded */
      }
      // Re-route the ORIGINAL draft (same deterministic profile routing as the
      // first dispatch) and isolate it in a brand-new workspace against the
      // current baseline.
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
): Promise<{ result: ValidatedAgentEnvelope; violation: string[] }> {
  const before = snapshotTree(ctx.projectRoot);
  const result = await dispatch(
    ctx,
    { ...task, write_scope: [], workspace: null, canonical_baseline: canonicalBaselineHash(ctx.paths) },
    routing,
  );
  const delta = diffTrees(before, snapshotTree(ctx.projectRoot));
  return { result, violation: delta.changed };
}

/**
 * True when a failed dispatch reflects a WORKFLOW-LEVEL teardown (a deadline
 * cancel, host disconnect, or supervisor disposal) rather than an agent-quality
 * failure. Workflow-level retry loops MUST NOT re-dispatch on this: the workflow
 * is being unwound, and a fresh dispatch would wedge on a host that will never
 * answer (blocking the deadline unwind). An ordinary bad/unparseable agent
 * result carries a descriptive summary and is not matched here, so genuine
 * agent-quality retries still proceed.
 */
export function isWorkflowCancellation(result: AgentResult): boolean {
  return /CANCELLED|WORKFLOW_DEADLINE|WORKFLOW_UNWIND|HOST_DISCONNECTED|supervisor disposed|external abort/i.test(
    result.summary,
  );
}

export function blocked(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  discardAllDecisionProposals(ctx);
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

/**
 * Report a blocker without rewriting the durable phase checkpoint. Use this
 * for read-only preflight refusals whose cause lives outside RIJO state (for
 * example, a dirty application checkout). Persisting that refusal would make
 * the RIJO metadata dirty too and could prevent a clean retry.
 */
export function blockedReadOnly(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  discardAllDecisionProposals(ctx);
  ctx.bus.emit('workflow.blocked', { status: 'blocked', message }, { details });
  return { ok: false, status: 'blocked', message, details };
}

export function failed(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  discardAllDecisionProposals(ctx);
  ctx.bus.emit('workflow.failed', { status: 'failed', message }, { details });
  return { ok: false, status: 'failed', message, details };
}

export function completed(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  discardAllDecisionProposals(ctx);
  ctx.bus.emit('workflow.completed', { status: 'completed', message }, { details });
  return { ok: true, status: 'completed', message, details };
}
