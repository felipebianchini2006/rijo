import * as fs from 'node:fs';
import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { writeJsonAtomic, appendLine, readJsonIfExists, ensureDir, sha256 } from '../core/fsx.js';
import {
  TaskRecordSchema,
  assertSupervisedTransition,
  type TaskRecord,
  type SupervisedTaskState,
} from '../core/schemas/index.js';
import { LEGACY_WORKFLOW_EPOCH } from '../core/workflow-epoch.js';

/**
 * Durable supervision state. Every task has one JSON projection under
 * `<runtimeDir>/tasks/<logical-task-id>.json`, written atomically, and an
 * append-only event log at `<runtimeDir>/task-events.jsonl`. The invariant:
 * an event is appended BEFORE the projection is updated, so a crash can never
 * leave a state change that has no audit trail (the log may be one step ahead
 * of the projection, never behind).
 */

export interface TaskEvent {
  ts: string;
  logical_task_id: string;
  workflow_epoch?: string;
  type: string;
  data: Record<string, unknown>;
}

/** States from which no further supervision action is ever needed. */
const TERMINAL: ReadonlySet<SupervisedTaskState> = new Set<SupervisedTaskState>([
  'SUCCEEDED',
  'EXHAUSTED',
]);
const ARCHIVABLE: ReadonlySet<SupervisedTaskState> = new Set<SupervisedTaskState>([
  'SUCCEEDED',
  'FAILED',
  'EXHAUSTED',
  'CANCELLED',
]);

/** Filesystem-safe form of a logical task id (read/write use the same mapping). */
function fileId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class TaskStore {
  constructor(private readonly paths: RijoPaths) {}

  get tasksDir(): string {
    return path.join(this.paths.runtimeDir, 'tasks');
  }

  get eventsFile(): string {
    return path.join(this.paths.runtimeDir, 'task-events.jsonl');
  }

  get archiveDir(): string {
    return path.join(this.tasksDir, 'archive');
  }

  private recordPath(id: string): string {
    return path.join(this.tasksDir, `${fileId(id)}.json`);
  }

  private archivePath(id: string, workflowEpoch: string): string {
    return path.join(
      this.archiveDir,
      `${fileId(id)}-${sha256(id).slice(0, 16)}`,
      `${fileId(workflowEpoch)}.json`,
    );
  }

  /** Append one event to the durable log. Always called before a projection write. */
  emit(
    logicalTaskId: string,
    type: string,
    data: Record<string, unknown> = {},
    workflowEpoch?: string,
  ): TaskEvent {
    const ev: TaskEvent = {
      ts: new Date().toISOString(),
      logical_task_id: logicalTaskId,
      ...(workflowEpoch ? { workflow_epoch: workflowEpoch } : {}),
      type,
      data,
    };
    ensureDir(path.dirname(this.eventsFile));
    appendLine(this.eventsFile, JSON.stringify(ev));
    return ev;
  }

  /** Tolerant read: missing or corrupt records return null instead of throwing. */
  read(logicalTaskId: string): TaskRecord | null {
    const raw = readJsonIfExists(this.recordPath(logicalTaskId));
    if (raw === null) return null;
    const candidate =
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      !('workflow_epoch' in raw)
        ? { ...(raw as Record<string, unknown>), workflow_epoch: LEGACY_WORKFLOW_EPOCH }
        : raw;
    const parsed = TaskRecordSchema.safeParse(candidate);
    if (!parsed.success) return null;
    if (parsed.data.logical_task_id !== logicalTaskId) {
      throw new Error(
        `Supervised task projection key collision between ${logicalTaskId} and ${parsed.data.logical_task_id}.`,
      );
    }
    return parsed.data;
  }

  readArchived(logicalTaskId: string, workflowEpoch: string): TaskRecord | null {
    const raw = readJsonIfExists(this.archivePath(logicalTaskId, workflowEpoch));
    if (raw === null) return null;
    const parsed = TaskRecordSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  private write(record: TaskRecord): void {
    writeJsonAtomic(this.recordPath(record.logical_task_id), record);
  }

  /** Persist a brand-new record (its initial state, usually QUEUED). */
  create(record: TaskRecord): TaskRecord {
    const valid = TaskRecordSchema.parse(record);
    if (this.read(valid.logical_task_id) !== null) {
      throw new Error(`Supervised task ${valid.logical_task_id} already has a durable record.`);
    }
    this.emit(
      valid.logical_task_id,
      'task_created',
      { state: valid.state, role: valid.role },
      valid.workflow_epoch,
    );
    this.write(valid);
    return valid;
  }

  /**
   * Archive a terminal projection and create generation 1 for a new workflow
   * epoch. The active projection is never overwritten until the archive is
   * durable. A different non-terminal epoch is always a closed conflict.
   */
  rolloverTerminal(prior: TaskRecord, nextRecord: TaskRecord): TaskRecord {
    const next = TaskRecordSchema.parse(nextRecord);
    const current = this.read(prior.logical_task_id);
    if (!current || current.workflow_epoch !== prior.workflow_epoch) {
      throw new Error(
        `Supervised task ${prior.logical_task_id} changed before workflow epoch rollover.`,
      );
    }
    if (!ARCHIVABLE.has(current.state)) {
      throw new Error(
        `Supervised task ${prior.logical_task_id} is ${current.state}; cross-epoch rollover is refused.`,
      );
    }
    if (current.workflow_epoch === next.workflow_epoch) {
      throw new Error(
        `Supervised task ${prior.logical_task_id} cannot roll over inside the same workflow epoch.`,
      );
    }
    if (next.generation !== 1 || next.replacement_count !== 0) {
      throw new Error(
        `Supervised task ${prior.logical_task_id} must start the new workflow epoch at generation 1.`,
      );
    }
    const archivePath = this.archivePath(current.logical_task_id, current.workflow_epoch);
    const archived = readJsonIfExists(archivePath);
    if (archived !== null) {
      const parsed = TaskRecordSchema.safeParse(archived);
      if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(current)) {
        throw new Error(
          `Supervised task ${prior.logical_task_id} has a conflicting immutable epoch archive.`,
        );
      }
    } else {
      writeJsonAtomic(archivePath, current);
    }
    this.emit(
      current.logical_task_id,
      'workflow_epoch_rolled_over',
      {
        prior_workflow_epoch: current.workflow_epoch,
        workflow_epoch: next.workflow_epoch,
        prior_state: current.state,
        revoked_lease_id: current.lease_id,
      },
      next.workflow_epoch,
    );
    this.write(next);
    return next;
  }

  /**
   * Fence and terminate a pre-epoch task. A legacy lease is never adopted by
   * native supervision. The legal transition chain preserves the full event
   * history and leaves an archivable EXHAUSTED projection for epoch rollover.
   */
  terminateLegacyNonterminal(prior: TaskRecord, reason: string): TaskRecord {
    let current = this.read(prior.logical_task_id);
    if (!current || current.workflow_epoch !== LEGACY_WORKFLOW_EPOCH) {
      throw new Error(
        `Supervised task ${prior.logical_task_id} is not an active legacy projection.`,
      );
    }
    if (current.state === 'SUCCEEDED' || current.state === 'EXHAUSTED') {
      return current;
    }
    const revoked = [
      ...new Set([...current.revoked_leases, current.lease_id]),
    ];
    current = this.patch(
      current,
      {
        revoked_leases: revoked,
        workspace_id: null,
        workspace_path: null,
        last_error: reason,
      },
      'legacy_lease_fenced',
      {
        revoked_lease_id: current.lease_id,
        workspace_invalidated: true,
        reason,
      },
    );
    if (current.state === 'QUEUED') {
      current = this.transition(
        current,
        'CANCELLED',
        { finished_at: new Date().toISOString() },
        { reason, migration: 'legacy_workflow_epoch' },
      );
    } else if (
      current.state === 'STARTING' ||
      current.state === 'RUNNING' ||
      current.state === 'AWAITING_NATIVE_RESULT' ||
      current.state === 'SUSPECT' ||
      current.state === 'CANCELLING'
    ) {
      current = this.transition(
        current,
        'ORPHANED',
        {},
        { reason, migration: 'legacy_workflow_epoch' },
      );
    }
    if (
      current.state === 'CANCELLED' ||
      current.state === 'FAILED' ||
      current.state === 'REPLACING' ||
      current.state === 'ORPHANED'
    ) {
      current = this.transition(
        current,
        'EXHAUSTED',
        { finished_at: new Date().toISOString(), last_error: reason },
        { reason, migration: 'legacy_workflow_epoch' },
      );
    }
    if (current.state !== 'EXHAUSTED') {
      throw new Error(
        `Legacy supervised task ${current.logical_task_id} could not reach a safe terminal state from ${current.state}.`,
      );
    }
    return current;
  }

  /**
   * Requeue an exact SUCCEEDED native identity without erasing its history.
   * EXHAUSTED is terminal for every replacement count and can never enter here.
   */
  requeueExisting(
    record: TaskRecord,
    patch: Partial<TaskRecord>,
    eventData: Record<string, unknown>,
  ): TaskRecord {
    if (record.state !== 'SUCCEEDED') {
      throw new Error(
        `Supervised task ${record.logical_task_id} cannot be requeued from ${record.state}.`,
      );
    }
    this.emit(record.logical_task_id, 'task_requeued', {
      from: record.state,
      ...eventData,
    }, record.workflow_epoch);
    const next = TaskRecordSchema.parse({ ...record, ...patch, state: 'QUEUED' });
    this.write(next);
    return next;
  }

  /**
   * Validated state transition. Order is mandatory: validate → append event →
   * write projection. An invalid transition throws a core error and no event or
   * write happens.
   */
  transition(
    record: TaskRecord,
    to: SupervisedTaskState,
    patch: Partial<TaskRecord> = {},
    eventData: Record<string, unknown> = {},
  ): TaskRecord {
    assertSupervisedTransition(record.logical_task_id, record.state, to);
    this.emit(
      record.logical_task_id,
      'state_transition',
      { from: record.state, to, ...eventData },
      record.workflow_epoch,
    );
    const next = TaskRecordSchema.parse({ ...record, ...patch, state: to });
    this.write(next);
    return next;
  }

  /**
   * Durable projection update WITHOUT a state change (e.g. fencing: revoking a
   * lease and invalidating a workspace). Still event-before-write.
   */
  patch(
    record: TaskRecord,
    patch: Partial<TaskRecord>,
    eventType: string,
    eventData: Record<string, unknown> = {},
  ): TaskRecord {
    this.emit(record.logical_task_id, eventType, eventData, record.workflow_epoch);
    const next = TaskRecordSchema.parse({ ...record, ...patch });
    this.write(next);
    return next;
  }

  /** Records still needing supervision (everything except SUCCEEDED/EXHAUSTED). */
  listNonTerminal(): TaskRecord[] {
    if (!fs.existsSync(this.tasksDir)) return [];
    const out: TaskRecord[] = [];
    for (const name of fs.readdirSync(this.tasksDir)) {
      if (!name.endsWith('.json')) continue;
      const raw = readJsonIfExists(path.join(this.tasksDir, name));
      if (raw === null) continue;
      const candidate =
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        !('workflow_epoch' in raw)
          ? { ...(raw as Record<string, unknown>), workflow_epoch: LEGACY_WORKFLOW_EPOCH }
          : raw;
      const parsed = TaskRecordSchema.safeParse(candidate);
      if (parsed.success && !TERMINAL.has(parsed.data.state)) out.push(parsed.data);
    }
    return out;
  }

  /** All events for one task, in order. Tolerant of malformed lines. */
  readEvents(logicalTaskId?: string): TaskEvent[] {
    if (!fs.existsSync(this.eventsFile)) return [];
    const lines = fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean);
    const out: TaskEvent[] = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as TaskEvent;
        if (logicalTaskId === undefined || ev.logical_task_id === logicalTaskId) out.push(ev);
      } catch {
        /* skip torn/partial trailing line */
      }
    }
    return out;
  }
}
