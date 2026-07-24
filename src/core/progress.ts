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

/**
 * Deterministic event bus. Every material transition, in order:
 *   1. structured event appended to events.jsonl
 *   2. atomic rewrite of runtime/status.json
 *   3. short terminal render
 * STATE.md updates are separate and only happen on verifiable checkpoints.
 */
export class ProgressBus {
  private snapshot: StatusSnapshot;

  constructor(
    private readonly paths: RijoPaths,
    public readonly runId: string,
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

  get current(): StatusSnapshot {
    return this.snapshot;
  }

  emit(type: string, update: ProgressUpdate = {}, data: Record<string, unknown> = {}): StatusSnapshot {
    const ts = this.now().toISOString();
    const event: RijoEvent = { ts, run_id: this.runId, type, data };
    appendLine(this.paths.events, JSON.stringify(event));

    this.snapshot = StatusSchema.parse({
      ...this.snapshot,
      status: update.status ?? this.snapshot.status,
      milestone: update.milestone !== undefined ? update.milestone : this.snapshot.milestone,
      phase: update.phase !== undefined ? update.phase : this.snapshot.phase,
      stage: update.stage !== undefined ? update.stage : this.snapshot.stage,
      task: update.task !== undefined ? update.task : this.snapshot.task,
      agent: update.agent !== undefined ? update.agent : this.snapshot.agent,
      completed_units: update.completedUnits ?? this.snapshot.completed_units,
      total_units: update.totalUnits ?? this.snapshot.total_units,
      last_checkpoint:
        update.lastCheckpoint !== undefined ? update.lastCheckpoint : this.snapshot.last_checkpoint,
      updated_at: ts,
      message: update.message ?? this.snapshot.message,
    });
    writeJsonAtomic(this.paths.status, this.snapshot);
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
