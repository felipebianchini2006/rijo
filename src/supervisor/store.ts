import * as fs from 'node:fs';
import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { writeJsonAtomic, appendLine, readJsonIfExists, ensureDir } from '../core/fsx.js';
import {
  TaskRecordSchema,
  assertSupervisedTransition,
  type TaskRecord,
  type SupervisedTaskState,
} from '../core/schemas/index.js';

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
  type: string;
  data: Record<string, unknown>;
}

/** States from which no further supervision action is ever needed. */
const TERMINAL: ReadonlySet<SupervisedTaskState> = new Set<SupervisedTaskState>(['SUCCEEDED', 'EXHAUSTED']);

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

  private recordPath(id: string): string {
    return path.join(this.tasksDir, `${fileId(id)}.json`);
  }

  /** Append one event to the durable log. Always called before a projection write. */
  emit(logicalTaskId: string, type: string, data: Record<string, unknown> = {}): TaskEvent {
    const ev: TaskEvent = { ts: new Date().toISOString(), logical_task_id: logicalTaskId, type, data };
    ensureDir(path.dirname(this.eventsFile));
    appendLine(this.eventsFile, JSON.stringify(ev));
    return ev;
  }

  /** Tolerant read: missing or corrupt records return null instead of throwing. */
  read(logicalTaskId: string): TaskRecord | null {
    const raw = readJsonIfExists(this.recordPath(logicalTaskId));
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
    this.emit(valid.logical_task_id, 'task_created', { state: valid.state, role: valid.role });
    this.write(valid);
    return valid;
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
    });
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
    this.emit(record.logical_task_id, 'state_transition', { from: record.state, to, ...eventData });
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
    this.emit(record.logical_task_id, eventType, eventData);
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
      const parsed = TaskRecordSchema.safeParse(raw);
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
