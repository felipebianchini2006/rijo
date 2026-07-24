import { RijoPaths } from '../core/paths.js';
import type { TaskRecord } from '../core/schemas/index.js';
import type { HostAgentController, HostAttemptHandle, HostAttemptStatus } from '../hosts/controller.js';
import { TaskStore } from './store.js';

/**
 * On restart the supervisor may find task records left mid-flight by a crashed
 * process. Reconciliation reads every non-terminal record and drives it to a
 * safe, deterministic outcome so a dead process's stale attempt can never later
 * apply a result: recoverable handles are probed; dead/disconnected/running
 * detached attempts are fenced (lease revoked, workspace invalidated) and
 * orphaned→cancelled; completed attempts are left for the caller to validate;
 * unknown attempts get a short bounded probe and are then treated as orphans.
 */

export type ControllerLookup = (
  record: TaskRecord,
) => { controller: HostAgentController; handle: HostAttemptHandle } | null | Promise<{ controller: HostAgentController; handle: HostAttemptHandle } | null>;

export interface ReconcileOptions {
  controllerLookup?: ControllerLookup;
  /** Bound for a single query() probe of an unknown/uncertain attempt. */
  unknownTimeoutMs?: number;
}

export type RecoveryAction = 'fenced' | 'orphaned_cancelled' | 'left_for_caller';

export interface RecoveryEntry {
  logical_task_id: string;
  from: TaskRecord['state'];
  classification: string;
  action: RecoveryAction;
  detail?: string;
}

export interface RecoveryReport {
  total: number;
  classifications: Record<string, number>;
  actions: Record<RecoveryAction, number>;
  entries: RecoveryEntry[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function fence(store: TaskStore, record: TaskRecord, reason: string): TaskRecord {
  const revoked = [...record.revoked_leases, record.lease_id];
  return store.patch(
    record,
    { revoked_leases: revoked, workspace_id: null, last_error: reason },
    'fenced',
    { lease_id: record.lease_id, reason, termination: 'not_supported', workspace_invalidated: true, recovery: true },
  );
}

/** Drive an orphaned attempt to CANCELLED via the shortest valid path for its state. */
function orphanCancel(store: TaskStore, record: TaskRecord): TaskRecord {
  if (record.state === 'REPLACING') {
    // A REPLACING record was between attempts (no live agent); terminate cleanly.
    return store.transition(record, 'EXHAUSTED', { finished_at: nowIso() }, { recovery: true });
  }
  let rec = record;
  if (rec.state !== 'ORPHANED') rec = store.transition(rec, 'ORPHANED', {}, { recovery: true });
  return store.transition(rec, 'CANCELLED', { finished_at: nowIso() }, { recovery: true });
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

export async function reconcileSupervisedTasks(
  paths: RijoPaths,
  opts: ReconcileOptions = {},
): Promise<RecoveryReport> {
  const store = new TaskStore(paths);
  const records = store.listNonTerminal();
  const unknownTimeoutMs = opts.unknownTimeoutMs ?? 2_000;
  const entries: RecoveryEntry[] = [];

  const record = (
    rec: TaskRecord,
    classification: string,
    action: RecoveryAction,
    detail?: string,
  ): void => {
    entries.push({ logical_task_id: rec.logical_task_id, from: rec.state, classification, action, detail });
  };

  for (const rec of records) {
    const from = rec.state;
    store.emit(rec.logical_task_id, 'recovery_seen', { state: from, generation: rec.generation });

    // Never started: no attempt could exist. Cancel directly (QUEUED→CANCELLED).
    if (from === 'QUEUED') {
      store.transition(rec, 'CANCELLED', { finished_at: nowIso() }, { recovery: 'never_started' });
      record(rec, 'never_started', 'orphaned_cancelled');
      continue;
    }

    const lookup = opts.controllerLookup ? await opts.controllerLookup(rec) : null;
    if (!lookup) {
      const fenced = fence(store, rec, 'recovery: no recoverable handle');
      orphanCancel(store, fenced);
      record(rec, 'no_handle', 'fenced');
      continue;
    }

    const status = await boundedQuery(lookup.controller, lookup.handle, unknownTimeoutMs);
    switch (status.kind) {
      case 'completed': {
        // Leave the (possibly applicable) result for the caller to validate.
        store.emit(rec.logical_task_id, 'recovery_completed', { detail: status.detail ?? null });
        if (rec.state !== 'ORPHANED') store.transition(rec, 'ORPHANED', {}, { recovery: 'completed_pending_validation' });
        record(rec, 'completed', 'left_for_caller', status.detail);
        break;
      }
      case 'running': {
        const fenced = fence(store, rec, 'recovery: running detached attempt cannot be re-supervised');
        orphanCancel(store, fenced);
        record(rec, 'running', 'fenced', status.detail);
        break;
      }
      case 'dead': {
        const fenced = fence(store, rec, 'recovery: attempt process dead');
        orphanCancel(store, fenced);
        record(rec, 'dead', 'fenced', status.detail);
        break;
      }
      case 'disconnected': {
        const fenced = fence(store, rec, 'recovery: attempt host disconnected');
        orphanCancel(store, fenced);
        record(rec, 'disconnected', 'fenced', status.detail);
        break;
      }
      case 'unknown':
      default: {
        const fenced = fence(store, rec, 'recovery: attempt status unknown after bounded probe');
        orphanCancel(store, fenced);
        record(rec, 'unknown', 'fenced', status.detail);
        break;
      }
    }
  }

  const classifications: Record<string, number> = {};
  const actions: Record<RecoveryAction, number> = { fenced: 0, orphaned_cancelled: 0, left_for_caller: 0 };
  for (const e of entries) {
    classifications[e.classification] = (classifications[e.classification] ?? 0) + 1;
    actions[e.action] += 1;
  }
  return { total: entries.length, classifications, actions, entries };
}
