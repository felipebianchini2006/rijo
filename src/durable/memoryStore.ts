import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  computeEventHash,
  redactDurableValue,
  sha256,
} from './canonical.js';
import { projectRunEvent } from './projection.js';
import {
  STATE_SCHEMA_VERSION,
  type Checkpoint,
  type DomainEvent,
  type DurableSnapshot,
  type DurableTransaction,
  type IntegrityResult,
  type Lease,
  type OutboxItem,
  type RunRecord,
  type SnapshotBuildInput,
  type StateStore,
  type StateTransaction,
  type StoredDomainEvent,
} from './types.js';

interface MemoryData {
  initialized: boolean;
  runs: Map<string, RunRecord>;
  events: StoredDomainEvent[];
  eventIdempotency: Map<string, number>;
  outbox: Map<string, OutboxItem>;
  checkpoints: Map<string, Checkpoint>;
  checkpointIdempotency: Set<string>;
  leases: Map<string, Lease>;
  attemptHeartbeats: Map<string, string>;
  snapshotBaselineSequence: number;
  snapshotBaselineHash: string;
}

export interface SerializedMemoryState {
  version: 1;
  initialized: boolean;
  runs: Array<[string, RunRecord]>;
  events: StoredDomainEvent[];
  eventIdempotency: Array<[string, number]>;
  outbox: Array<[string, OutboxItem]>;
  checkpoints: Array<[string, Checkpoint]>;
  checkpointIdempotency: string[];
  leases: Array<[string, Lease]>;
  attemptHeartbeats: Array<[string, string]>;
  snapshotBaselineSequence: number;
  snapshotBaselineHash: string;
}

function cloneData(data: MemoryData): MemoryData {
  return structuredClone(data);
}

function defaultData(): MemoryData {
  return {
    initialized: false,
    runs: new Map(),
    events: [],
    eventIdempotency: new Map(),
    outbox: new Map(),
    checkpoints: new Map(),
    checkpointIdempotency: new Set(),
    leases: new Map(),
    attemptHeartbeats: new Map(),
    snapshotBaselineSequence: 0,
    snapshotBaselineHash: '',
  };
}

function defaultOutbox(event: StoredDomainEvent): OutboxItem {
  const redacted = redactDurableValue(event) as Record<string, unknown>;
  const payload = redacted['payload'] as Record<string, unknown> | undefined;
  const content = {
    ...redacted,
    type: event.event_type,
    data: payload?.['data'] ?? payload ?? {},
  };
  return {
    id: `event-${event.sequence}`,
    event_sequence: event.sequence,
    projection_type: 'EVENTS_JSONL',
    destination: '.rijo/events.jsonl',
    content_hash: sha256(canonicalJson(content)),
    content,
    status: 'PENDING',
    attempts: 0,
    last_error: null,
    created_at: event.created_at,
    projected_at: null,
  };
}

export class MemoryStateStore implements StateStore {
  private data: MemoryData = defaultData();

  async initialize(): Promise<void> {
    this.data.initialized = true;
  }

  async migrate(): Promise<void> {
    this.data.initialized = true;
  }

  async transaction<T>(fn: StateTransaction<T>): Promise<T> {
    this.assertOpen();
    const before = cloneData(this.data);
    const tx = this.transactionView();
    try {
      return await fn(tx);
    } catch (error) {
      this.data = before;
      throw error;
    }
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    await this.transaction((tx) => tx.appendEvent(event));
  }

  appendEventImmediate(event: DomainEvent): StoredDomainEvent {
    this.assertOpen();
    const before = cloneData(this.data);
    try {
      return this.appendEventInternal(event);
    } catch (error) {
      this.data = before;
      throw error;
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return structuredClone(this.data.runs.get(runId) ?? null);
  }

  async getActiveRun(): Promise<RunRecord | null> {
    const active = [...this.data.runs.values()]
      .filter((run) => run.status === 'CREATED' || run.status === 'RUNNING')
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return structuredClone(active ?? null);
  }

  async getLatestRun(): Promise<RunRecord | null> {
    const latest = [...this.data.runs.values()]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return structuredClone(latest ?? null);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.transaction((tx) => tx.saveCheckpoint(checkpoint));
  }

  async claimTask(taskId: string, lease: Lease): Promise<boolean> {
    return this.transaction((tx) => tx.claimTask(taskId, lease));
  }

  async heartbeatAttempt(attemptId: string): Promise<void> {
    await this.transaction((tx) => tx.heartbeatAttempt(attemptId));
  }

  async fenceAttempt(attemptId: string, reason: string): Promise<void> {
    await this.transaction((tx) => tx.fenceAttempt(attemptId, reason));
  }

  async enqueueOutbox(item: OutboxItem): Promise<void> {
    await this.transaction((tx) => tx.enqueueOutbox(item));
  }

  async readPendingOutbox(): Promise<OutboxItem[]> {
    return structuredClone(
      [...this.data.outbox.values()]
        .filter((item) => item.status === 'PENDING')
        .sort((left, right) => left.event_sequence - right.event_sequence),
    );
  }

  async markOutboxProjected(id: string): Promise<void> {
    const item = this.data.outbox.get(id);
    if (!item || item.status === 'PROJECTED') return;
    this.data.outbox.set(id, {
      ...item,
      status: 'PROJECTED',
      projected_at: new Date().toISOString(),
      attempts: item.attempts + 1,
    });
  }

  async integrityCheck(): Promise<IntegrityResult> {
    const errors: string[] = [];
    let previousHash = this.data.snapshotBaselineHash;
    let expectedSequence = this.data.snapshotBaselineSequence + 1;
    for (const event of this.data.events) {
      if (event.sequence !== expectedSequence) {
        errors.push(`event sequence gap: expected ${expectedSequence}, found ${event.sequence}`);
      }
      if (event.previous_event_hash !== previousHash) {
        errors.push(`event ${event.sequence}: previous event hash mismatch`);
      }
      const expectedHash = computeEventHash(
        event.sequence,
        event.event_type,
        event.aggregate_id,
        event.payload,
        event.previous_event_hash,
      );
      if (event.event_hash !== expectedHash) errors.push(`event ${event.sequence}: event hash mismatch`);
      previousHash = event.event_hash;
      expectedSequence = event.sequence + 1;
    }
    const projectedSequence = Math.max(
      this.data.snapshotBaselineSequence,
      ...[...this.data.runs.values()].map((run) => run.last_event_sequence),
    );
    if (projectedSequence !== expectedSequence - 1) {
      errors.push(
        `event truncation detected: projections reached ${projectedSequence}, chain reached ${expectedSequence - 1}`,
      );
    }
    return {
      ok: errors.length === 0,
      quick_check: 'ok',
      integrity_check: 'ok',
      schema_version: STATE_SCHEMA_VERSION,
      last_event_sequence: expectedSequence - 1,
      last_event_hash: previousHash,
      errors,
    };
  }

  async createBackup(_target: string): Promise<void> {
    throw new Error('MemoryStateStore does not create filesystem backups');
  }

  async rebuild(snapshot: DurableSnapshot, events: DomainEvent[]): Promise<void> {
    this.assertOpen();
    this.data = defaultData();
    this.data.initialized = true;
    this.data.snapshotBaselineSequence = snapshot.last_sequence;
    this.data.snapshotBaselineHash = snapshot.last_event_hash;
    if (snapshot.run) this.data.runs.set(snapshot.run.id, structuredClone(snapshot.run));
    for (const item of snapshot.outbox_pending) this.data.outbox.set(item.id, structuredClone(item));
    for (const checkpoint of snapshot.checkpoints) {
      this.data.checkpoints.set(checkpoint.id, structuredClone(checkpoint));
      this.data.checkpointIdempotency.add(checkpoint.idempotency_key);
    }
    for (const lease of snapshot.leases) this.data.leases.set(lease.id, structuredClone(lease));
    for (const event of events) await this.appendEvent(event);
    const integrity = await this.integrityCheck();
    if (!integrity.ok) throw new Error(`Rebuilt state failed integrity: ${integrity.errors.join('; ')}`);
  }

  async readEvents(afterSequence = 0): Promise<StoredDomainEvent[]> {
    return structuredClone(this.data.events.filter((event) => event.sequence > afterSequence));
  }

  async exportSnapshot(input: SnapshotBuildInput): Promise<DurableSnapshot> {
    const integrity = await this.integrityCheck();
    const run = await this.getActiveRun() ?? structuredClone([...this.data.runs.values()].at(-1) ?? null);
    return {
      schema_version: STATE_SCHEMA_VERSION,
      run,
      active_milestone: null,
      active_phase: null,
      active_task: null,
      milestones: [],
      phases: [],
      requirements: [],
      roadmap: [],
      tasks: [],
      decisions: [],
      command_evidence: [],
      map_state: null,
      attempts: [],
      leases: structuredClone([...this.data.leases.values()]),
      process_receipts: [],
      recovery_receipts: [],
      checkpoints: structuredClone([...this.data.checkpoints.values()]),
      last_sequence: integrity.last_event_sequence,
      last_event_hash: integrity.last_event_hash,
      git_commit: input.git_commit,
      artifact_hashes: { ...input.artifact_hashes },
      outbox_pending: await this.readPendingOutbox(),
      generated_at: input.generated_at,
    };
  }

  async close(): Promise<void> {
    this.data.initialized = false;
  }

  /** Internal persistence image used by FileStateStore. */
  exportData(): SerializedMemoryState {
    return structuredClone({
      version: 1,
      initialized: this.data.initialized,
      runs: [...this.data.runs.entries()],
      events: this.data.events,
      eventIdempotency: [...this.data.eventIdempotency.entries()],
      outbox: [...this.data.outbox.entries()],
      checkpoints: [...this.data.checkpoints.entries()],
      checkpointIdempotency: [...this.data.checkpointIdempotency],
      leases: [...this.data.leases.entries()],
      attemptHeartbeats: [...this.data.attemptHeartbeats.entries()],
      snapshotBaselineSequence: this.data.snapshotBaselineSequence,
      snapshotBaselineHash: this.data.snapshotBaselineHash,
    });
  }

  /** Internal recovery hook used only after FileStateStore verifies its checksum. */
  importData(raw: SerializedMemoryState): void {
    if (raw.version !== 1) throw new Error(`Unsupported file state format: ${raw.version}`);
    this.data = {
      initialized: true,
      runs: new Map(structuredClone(raw.runs)),
      events: structuredClone(raw.events),
      eventIdempotency: new Map(raw.eventIdempotency),
      outbox: new Map(structuredClone(raw.outbox)),
      checkpoints: new Map(structuredClone(raw.checkpoints)),
      checkpointIdempotency: new Set(raw.checkpointIdempotency),
      leases: new Map(structuredClone(raw.leases)),
      attemptHeartbeats: new Map(raw.attemptHeartbeats),
      snapshotBaselineSequence: raw.snapshotBaselineSequence,
      snapshotBaselineHash: raw.snapshotBaselineHash,
    };
  }

  private assertOpen(): void {
    if (!this.data.initialized) throw new Error('StateStore is not initialized');
  }

  private transactionView(): DurableTransaction {
    return {
      appendEvent: async (event) => this.appendEventInternal(event),
      saveCheckpoint: async (checkpoint) => this.saveCheckpointInternal(checkpoint),
      claimTask: async (taskId, lease) => this.claimTaskInternal(taskId, lease),
      heartbeatAttempt: async (attemptId) => {
        this.data.attemptHeartbeats.set(attemptId, new Date().toISOString());
      },
      fenceAttempt: async (attemptId, reason) => this.fenceAttemptInternal(attemptId, reason),
      enqueueOutbox: async (item) => this.enqueueOutboxInternal(item),
    };
  }

  private appendEventInternal(raw: DomainEvent): StoredDomainEvent {
    const duplicateSequence = this.data.eventIdempotency.get(raw.idempotency_key);
    if (duplicateSequence !== undefined) {
      return this.data.events.find((event) => event.sequence === duplicateSequence)!;
    }
    const last = this.data.events.at(-1);
    const sequence = (last?.sequence ?? this.data.snapshotBaselineSequence) + 1;
    const previousHash = last?.event_hash ?? this.data.snapshotBaselineHash;
    const payload = redactDurableValue(raw.payload);
    const event: StoredDomainEvent = {
      ...raw,
      sequence,
      payload,
      previous_event_hash: previousHash,
      event_hash: computeEventHash(
        sequence,
        raw.event_type,
        raw.aggregate_id,
        payload,
        previousHash,
      ),
    };
    const currentRun = this.data.runs.get(event.run_id) ?? null;
    const projected = projectRunEvent(currentRun, event);
    if (!projected && event.event_type !== 'run.created') {
      throw new Error(`Event ${event.event_type} references missing run ${event.run_id}`);
    }
    this.data.events.push(event);
    this.data.eventIdempotency.set(event.idempotency_key, sequence);
    if (projected) this.data.runs.set(projected.id, projected);
    this.enqueueOutboxInternal(defaultOutbox(event));
    return event;
  }

  private saveCheckpointInternal(checkpoint: Checkpoint): void {
    if (this.data.checkpointIdempotency.has(checkpoint.idempotency_key)) return;
    if (!this.data.runs.has(checkpoint.run_id)) {
      throw new Error(`Checkpoint references missing run ${checkpoint.run_id}`);
    }
    this.data.checkpoints.set(checkpoint.id, structuredClone(redactDurableValue(checkpoint) as Checkpoint));
    this.data.checkpointIdempotency.add(checkpoint.idempotency_key);
  }

  private claimTaskInternal(taskId: string, lease: Lease): boolean {
    const active = [...this.data.leases.values()].find(
      (item) => item.logical_task_id === taskId && item.state === 'ACTIVE',
    );
    if (active && active.id !== lease.id) return false;
    this.data.leases.set(lease.id, structuredClone(lease));
    return true;
  }

  private fenceAttemptInternal(attemptId: string, reason: string): void {
    for (const [id, lease] of this.data.leases) {
      if (lease.attempt_id !== attemptId || lease.state !== 'ACTIVE') continue;
      this.data.leases.set(id, {
        ...lease,
        state: 'REVOKED',
        fenced_at: new Date().toISOString(),
        fence_reason: reason,
      });
    }
  }

  private enqueueOutboxInternal(raw: OutboxItem): void {
    if (this.data.outbox.has(raw.id)) return;
    const item = redactDurableValue(raw) as OutboxItem;
    this.data.outbox.set(item.id || randomUUID(), structuredClone(item));
  }
}
