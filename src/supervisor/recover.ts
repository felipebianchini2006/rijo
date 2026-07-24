import { RijoPaths } from '../core/paths.js';
import { SupervisorConfigSchema, type SupervisedTaskState, type TaskRecord } from '../core/schemas/index.js';
import type { HostAgentController, HostAttemptHandle, HostAttemptStatus } from '../hosts/controller.js';
import { TaskStore } from './store.js';

/**
 * On restart the supervisor may find task records left mid-flight by a crashed
 * process. Reconciliation reads every non-terminal record and drives it — via
 * ONLY transitions permitted by SUPERVISED_TRANSITIONS (every step goes through
 * assertSupervisedTransition inside TaskStore) — to a safe, deterministic
 * outcome so a dead process's stale attempt can never later apply a result:
 *
 *  - QUEUED (never started, no attempt to fence) is driven to a genuinely
 *    terminal state: QUEUED → CANCELLED → EXHAUSTED. It is never resumed —
 *    recovery cannot reconstruct the intended attempt, and the enclosing
 *    workflow re-enqueues a fresh logical task if the work is still needed.
 *
 *  - Every other non-terminal record represents an attempt that was (or may
 *    have been) in flight. Its lease is revoked and its workspace invalidated
 *    (FENCING) so nothing it returns — including a "completed but never
 *    validated/applied" result delivered just before the crash — can ever be
 *    applied. A completed-yet-unapplied result is deliberately DISCARDED rather
 *    than trusted, because the core cannot prove it was validated and applied
 *    atomically before the crash. After fencing, the record is driven to:
 *      * REPLACING when replacement budget remains (`replacement_count <
 *        max_replacements_per_task`) — a "resumed" outcome the next
 *        superviseTask picks up with a brand-new attempt and workspace;
 *      * EXHAUSTED (terminal) when no budget remains.
 *    Continuation is always safe once fencing succeeds: the revoked lease and
 *    invalidated workspace guarantee the crashed attempt is inert, so the sole
 *    remaining discriminator between resume and terminate is the budget.
 *
 * Idempotency: running reconciliation twice in a row produces the same final
 * state and the SECOND pass emits ZERO new events. Terminal outcomes
 * (EXHAUSTED) are simply no longer listed. A "resumed" record left in REPLACING
 * — fenced (its lease revoked) with its workspace invalidated — is recognized
 * as already reconciled and skipped before any event is emitted.
 */

export type ControllerLookup = (
  record: TaskRecord,
) => { controller: HostAgentController; handle: HostAttemptHandle } | null | Promise<{ controller: HostAgentController; handle: HostAttemptHandle } | null>;

export interface ReconcileOptions {
  controllerLookup?: ControllerLookup;
  /** Bound for a single query() probe of an unknown/uncertain attempt. */
  unknownTimeoutMs?: number;
  /**
   * Replacement budget ceiling. A record with `replacement_count` below this is
   * resumed (→ REPLACING); otherwise it is terminated (→ EXHAUSTED). Defaults to
   * the supervisor schema default so a caller that omits it stays consistent.
   */
  maxReplacements?: number;
}

/** 'resumed' → REPLACING (budget remains); 'exhausted' → EXHAUSTED (terminal). */
export type RecoveryAction = 'resumed' | 'exhausted';

export interface RecoveryEntry {
  logical_task_id: string;
  from: TaskRecord['state'];
  classification: string;
  action: RecoveryAction;
  /** Whether this pass fenced the prior attempt (revoked its lease). */
  fenced: boolean;
  detail?: string;
}

export interface RecoveryReport {
  total: number;
  classifications: Record<string, number>;
  actions: Record<RecoveryAction, number>;
  entries: RecoveryEntry[];
}

const DEFAULT_MAX_REPLACEMENTS = SupervisorConfigSchema.parse({}).max_replacements_per_task;

/** Truly in-flight states: an attempt may still be alive and is probed. */
const IN_FLIGHT: ReadonlySet<SupervisedTaskState> = new Set<SupervisedTaskState>([
  'STARTING',
  'RUNNING',
  'SUSPECT',
  'CANCELLING',
]);

/**
 * States from which REPLACING/EXHAUSTED are not directly reachable and which
 * must first pass through ORPHANED (a permitted step for every one of them).
 */
const NEEDS_ORPHAN: ReadonlySet<SupervisedTaskState> = new Set<SupervisedTaskState>([
  'STARTING',
  'RUNNING',
  'SUSPECT',
  'CANCELLING',
]);

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A record already reconciled to a resumable outcome by a previous pass:
 * REPLACING, its current lease revoked, its workspace invalidated. Recognized
 * before any event is emitted so a second reconciliation pass is a true no-op.
 */
function isReconciledResumable(rec: TaskRecord): boolean {
  return rec.state === 'REPLACING' && rec.workspace_id === null && rec.revoked_leases.includes(rec.lease_id);
}

/**
 * Fence the record's current attempt: revoke its lease and invalidate its
 * workspace so no stale/echoed result can ever apply. No state change (patch
 * only); the lease is de-duplicated so repeat fencing is content-idempotent.
 */
function fence(store: TaskStore, rec: TaskRecord, reason: string): TaskRecord {
  const revoked = rec.revoked_leases.includes(rec.lease_id)
    ? rec.revoked_leases
    : [...rec.revoked_leases, rec.lease_id];
  return store.patch(
    rec,
    { revoked_leases: revoked, workspace_id: null, last_error: reason },
    'fenced',
    { lease_id: rec.lease_id, reason, termination: 'not_supported', workspace_invalidated: true, recovery: true },
  );
}

async function boundedQuery(
  controller: HostAgentController,
  handle: HostAttemptHandle,
  ms: number,
): Promise<HostAttemptStatus> {
  return Promise.race<HostAttemptStatus>([
    Promise.resolve()
      .then(() => controller.query(handle))
      .catch(() => ({ kind: 'unknown', detail: 'query threw' })),
    new Promise<HostAttemptStatus>((resolve) => {
      const t = setTimeout(() => resolve({ kind: 'unknown', detail: 'query timed out' }), ms);
      t.unref?.();
    }),
  ]);
}

interface Classification {
  classification: string;
  reason: string;
  detail?: string;
}

/** Classify an in-flight record by probing its (possibly) recoverable handle. */
async function classifyInFlight(rec: TaskRecord, opts: ReconcileOptions, unknownTimeoutMs: number): Promise<Classification> {
  const lookup = opts.controllerLookup ? await opts.controllerLookup(rec) : null;
  if (!lookup) return { classification: 'no_handle', reason: 'recovery: no recoverable handle' };
  const status = await boundedQuery(lookup.controller, lookup.handle, unknownTimeoutMs);
  const detail = status.detail;
  switch (status.kind) {
    case 'completed':
      // Result arrived but was never proven validated/applied before the crash:
      // discard it with fencing rather than trust an unverifiable outcome.
      return { classification: 'completed_discarded', reason: 'recovery: completed result unvalidated at crash, discarded', detail };
    case 'running':
      return { classification: 'running', reason: 'recovery: running detached attempt cannot be re-supervised', detail };
    case 'dead':
      return { classification: 'dead', reason: 'recovery: attempt process dead', detail };
    case 'disconnected':
      return { classification: 'disconnected', reason: 'recovery: attempt host disconnected', detail };
    case 'unknown':
    default:
      return { classification: 'unknown', reason: 'recovery: attempt status unknown after bounded probe', detail };
  }
}

async function reconcileRecord(
  store: TaskStore,
  rec: TaskRecord,
  opts: ReconcileOptions,
  unknownTimeoutMs: number,
  maxReplacements: number,
): Promise<RecoveryEntry | null> {
  const from = rec.state;

  // Idempotency guard: a previously-reconciled resumable record needs nothing.
  if (isReconciledResumable(rec)) return null;

  store.emit(rec.logical_task_id, 'recovery_seen', { state: from, generation: rec.generation });

  // QUEUED: never started, no attempt exists to fence. Drive to a genuinely
  // terminal state (QUEUED → CANCELLED → EXHAUSTED); never resumed.
  if (from === 'QUEUED') {
    let r = store.transition(rec, 'CANCELLED', { finished_at: nowIso() }, { recovery: 'never_started' });
    r = store.transition(r, 'EXHAUSTED', { finished_at: nowIso() }, { recovery: 'never_started' });
    return { logical_task_id: rec.logical_task_id, from, classification: 'never_started', action: 'exhausted', fenced: false };
  }

  // Classify. Only truly in-flight states are probed; settled states
  // (CANCELLED/FAILED/ORPHANED/REPLACING) are classified from their own state.
  const c: Classification = IN_FLIGHT.has(from)
    ? await classifyInFlight(rec, opts, unknownTimeoutMs)
    : { classification: from.toLowerCase(), reason: `recovery: reconciling ${from} record left by crash` };

  // Fence the prior attempt: nothing it returns can ever be applied.
  let cur = fence(store, rec, c.reason);
  const fenced = cur.revoked_leases.includes(cur.lease_id);

  // Reach a valid target. In-flight states cannot go straight to
  // REPLACING/EXHAUSTED, so they pass through ORPHANED first (a permitted step).
  // CANCELLED and FAILED go DIRECTLY to REPLACING/EXHAUSTED — the table forbids
  // routing them through ORPHANED.
  if (NEEDS_ORPHAN.has(cur.state)) cur = store.transition(cur, 'ORPHANED', {}, { recovery: c.classification });

  // Resume when budget remains and continuation is safe (fencing guaranteed it);
  // otherwise terminate.
  const resume = cur.replacement_count < maxReplacements;
  let action: RecoveryAction;
  if (resume) {
    // REPLACING source stays REPLACING (already fenced above → resumable);
    // any other state transitions into it.
    if (cur.state !== 'REPLACING') cur = store.transition(cur, 'REPLACING', {}, { recovery: 'resumable' });
    action = 'resumed';
  } else {
    cur = store.transition(cur, 'EXHAUSTED', { finished_at: nowIso() }, { recovery: 'no_budget' });
    action = 'exhausted';
  }

  const entry: RecoveryEntry = { logical_task_id: rec.logical_task_id, from, classification: c.classification, action, fenced };
  if (c.detail !== undefined) entry.detail = c.detail;
  return entry;
}

export async function reconcileSupervisedTasks(
  paths: RijoPaths,
  opts: ReconcileOptions = {},
): Promise<RecoveryReport> {
  const store = new TaskStore(paths);
  const records = store.listNonTerminal();
  const unknownTimeoutMs = opts.unknownTimeoutMs ?? 2_000;
  const maxReplacements = opts.maxReplacements ?? DEFAULT_MAX_REPLACEMENTS;
  const entries: RecoveryEntry[] = [];

  for (const rec of records) {
    const entry = await reconcileRecord(store, rec, opts, unknownTimeoutMs, maxReplacements);
    if (entry) entries.push(entry);
  }

  const classifications: Record<string, number> = {};
  const actions: Record<RecoveryAction, number> = { resumed: 0, exhausted: 0 };
  for (const e of entries) {
    classifications[e.classification] = (classifications[e.classification] ?? 0) + 1;
    actions[e.action] += 1;
  }
  return { total: entries.length, classifications, actions, entries };
}
