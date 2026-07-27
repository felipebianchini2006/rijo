import {
  SCHEMA_VERSION,
  StatusSchema,
  type RijoEvent,
  type RunStatus,
  type Stage,
  type StatusSnapshot,
  type ModelRole,
} from './schemas/index.js';
import { appendLine, writeJsonAtomic, readJsonIfExists } from './fsx.js';
import type { RijoPaths } from './paths.js';
import { redactDurableValue } from '../durable/canonical.js';

export interface ProgressSink {
  /** Short line rendered to the terminal on material transitions. */
  render(line: string): void;
}

export const consoleSink: ProgressSink = {
  render(line: string) {
    // eslint-disable-next-line no-console
    console.log(line);
  },
};

export const silentSink: ProgressSink = { render() {} };

/**
 * Progress sink that writes to stderr, keeping stdout clean for the command's
 * own result. Used by the turnkey host mode so live progress/heartbeat lines
 * stay legible without corrupting a machine-readable stdout.
 */
export const stderrSink: ProgressSink = {
  render(line: string) {
    process.stderr.write(`${line}\n`);
  },
};

export interface ProgressUpdate {
  status?: RunStatus;
  milestone?: { id: string; name: string } | null;
  phase?: { id: string; index: number; total: number; name: string } | null;
  stage?: Stage | null;
  task?: { id: string; index: number; total: number; name: string } | null;
  agent?: { role: ModelRole; id: string } | null;
  completedUnits?: number;
  totalUnits?: number;
  lastCheckpoint?: string | null;
  message?: string;
}

export interface DurableProgressRecord {
  runId: string;
  type: string;
  ts: string;
  update: ProgressUpdate;
  data: Record<string, unknown>;
  snapshot: StatusSnapshot;
}

/**
 * Narrow durable boundary used by ProgressBus. The concrete durable engine may
 * write synchronously (better-sqlite3) or return a promise; the bus retains and
 * flushes asynchronous work before the enclosing workflow releases its lock.
 */
export interface DurableProgressRecorder {
  recordProgress(record: DurableProgressRecord): void | Promise<void>;
}

function scrubBearerBeforeGenericRedaction(value: unknown): unknown {
  if (typeof value === 'string') {
    // The generic log redactor recognizes the word "Bearer" independently.
    // Strip the whole credential first so a later replacement cannot leave
    // the token tail behind as ordinary text.
    return value.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(scrubBearerBeforeGenericRedaction);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        scrubBearerBeforeGenericRedaction(child),
      ]),
    );
  }
  return value;
}

/**
 * Deterministic event bus. Every material transition, in order:
 *   1. structured event appended to events.jsonl
 *   2. atomic rewrite of runtime/status.json
 *   3. short terminal render
 * STATE.md updates are separate and only happen on verifiable checkpoints.
 */
export class ProgressBus {
  private snapshot: StatusSnapshot;
  private durable: DurableProgressRecorder | null = null;
  private durablePending: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: RijoPaths,
    public runId: string,
    private readonly sink: ProgressSink = consoleSink,
    private readonly now: () => Date = () => new Date(),
  ) {
    const startedAt = this.now().toISOString();
    this.snapshot = {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      status: 'idle',
      milestone: null,
      phase: null,
      stage: null,
      task: null,
      agent: null,
      completed_units: 0,
      total_units: 0,
      last_checkpoint: null,
      started_at: startedAt,
      updated_at: startedAt,
      message: '',
    };
  }

  /**
   * Switch progress persistence to the durable engine. From this point onward
   * ProgressBus no longer writes events/status directly: event + projection are
   * one durable-engine responsibility (transaction + outbox).
   */
  attachDurable(recorder: DurableProgressRecorder, runId = this.runId): void {
    this.durable = recorder;
    this.runId = runId;
    this.snapshot = { ...this.snapshot, run_id: runId };
  }

  async flushDurable(): Promise<void> {
    await this.durablePending;
  }

  get current(): StatusSnapshot {
    return this.snapshot;
  }

  emit(type: string, update: ProgressUpdate = {}, data: Record<string, unknown> = {}): StatusSnapshot {
    const ts = this.now().toISOString();
    const safeUpdate = redactDurableValue(scrubBearerBeforeGenericRedaction(update)) as ProgressUpdate;
    const safeData = redactDurableValue(scrubBearerBeforeGenericRedaction(data)) as Record<string, unknown>;
    const event: RijoEvent = { ts, run_id: this.runId, type, data: safeData };

    this.snapshot = StatusSchema.parse({
      ...this.snapshot,
      status: safeUpdate.status ?? this.snapshot.status,
      milestone: safeUpdate.milestone !== undefined ? safeUpdate.milestone : this.snapshot.milestone,
      phase: safeUpdate.phase !== undefined ? safeUpdate.phase : this.snapshot.phase,
      stage: safeUpdate.stage !== undefined ? safeUpdate.stage : this.snapshot.stage,
      task: safeUpdate.task !== undefined ? safeUpdate.task : this.snapshot.task,
      agent: safeUpdate.agent !== undefined ? safeUpdate.agent : this.snapshot.agent,
      completed_units: safeUpdate.completedUnits ?? this.snapshot.completed_units,
      total_units: safeUpdate.totalUnits ?? this.snapshot.total_units,
      last_checkpoint:
        safeUpdate.lastCheckpoint !== undefined ? safeUpdate.lastCheckpoint : this.snapshot.last_checkpoint,
      updated_at: ts,
      message: safeUpdate.message ?? this.snapshot.message,
    });
    if (this.durable) {
      const record: DurableProgressRecord = {
        runId: this.runId,
        type,
        ts,
        update: safeUpdate,
        data: safeData,
        snapshot: this.snapshot,
      };
      // Invoke immediately: the production SQLite recorder commits before it
      // returns. Deferring invocation through `.then()` would create a crash
      // window in which the caller observed progress that never reached the
      // ledger. Promise results are retained only for ACK/error flushing.
      const pending = this.durable.recordProgress(record);
      if (pending && typeof (pending as Promise<void>).then === 'function') {
        this.durablePending = Promise.all([this.durablePending, pending]).then(() => undefined);
      }
    } else {
      appendLine(this.paths.events, JSON.stringify(event));
      writeJsonAtomic(this.paths.status, this.snapshot);
    }
    this.sink.render(renderStatusLine(this.snapshot));
    return this.snapshot;
  }
}

export function renderStatusLine(s: StatusSnapshot): string {
  const parts: string[] = ['[RIJO'];
  if (s.milestone) parts.push(s.milestone.id);
  if (s.phase) parts.push(`F${s.phase.id}/${String(s.phase.total).padStart(2, '0')}`);
  let head = parts.join(' ') + ']';
  if (s.stage) head += ` ${s.stage}`;
  if (s.task) head += ` T${s.task.id.replace(/^T/, '')}/${String(s.task.total).padStart(2, '0')}`;
  return s.message ? `${head}  ${s.message}` : head;
}

export function readStatus(paths: RijoPaths): StatusSnapshot | null {
  const raw = readJsonIfExists<unknown>(paths.status);
  if (raw === null) return null;
  const parsed = StatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function newRunId(now: () => Date = () => new Date()): string {
  const t = now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.floor(Math.random() * 1e8).toString(36);
  return `run_${t}_${rand}`;
}
