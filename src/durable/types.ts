export const STATE_SCHEMA_VERSION = 2;

export type DurableRunStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'READY'
  | 'NOT_READY'
  | 'BLOCKED';

export interface RunRecord {
  id: string;
  plan_hash: string;
  host: string;
  status: DurableRunStatus;
  created_at: string;
  updated_at: string;
  started_commit: string | null;
  final_commit: string | null;
  active_milestone: string | null;
  active_phase: string | null;
  active_task: string | null;
  last_event_sequence: number;
  terminal_reason: string | null;
}

export interface DomainEvent {
  sequence?: number;
  event_id: string;
  run_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  payload: unknown;
  previous_event_hash?: string;
  event_hash?: string;
  created_at: string;
  idempotency_key: string;
}

export interface StoredDomainEvent extends DomainEvent {
  sequence: number;
  previous_event_hash: string;
  event_hash: string;
}

export interface Checkpoint {
  id: string;
  run_id: string;
  event_sequence: number;
  kind: 'TASK' | 'PHASE' | 'MILESTONE' | 'MIGRATION' | 'TERMINAL';
  git_commit: string | null;
  tree_hash: string | null;
  snapshot_hash: string | null;
  created_at: string;
  idempotency_key: string;
}

export interface Lease {
  id: string;
  run_id: string;
  logical_task_id: string | null;
  attempt_id: string | null;
  owner_id: string;
  generation: number;
  state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  fenced_at: string | null;
  fence_reason: string | null;
  idempotency_key: string;
}

export interface OutboxItem {
  id: string;
  event_sequence: number;
  projection_type: string;
  destination: string;
  content_hash: string;
  content?: unknown;
  status: 'PENDING' | 'PROJECTED' | 'FAILED';
  attempts: number;
  last_error: string | null;
  created_at: string;
  projected_at: string | null;
}

export interface IntegrityResult {
  ok: boolean;
  quick_check: string;
  integrity_check: string;
  schema_version: number;
  last_event_sequence: number;
  last_event_hash: string;
  errors: string[];
}

export interface SnapshotEntity {
  [key: string]: unknown;
}

export interface DurableSnapshot {
  schema_version: number;
  run: RunRecord | null;
  active_milestone: SnapshotEntity | null;
  active_phase: SnapshotEntity | null;
  active_task: SnapshotEntity | null;
  milestones: SnapshotEntity[];
  phases: SnapshotEntity[];
  requirements: SnapshotEntity[];
  roadmap: SnapshotEntity[];
  tasks: SnapshotEntity[];
  decisions: SnapshotEntity[];
  command_evidence: SnapshotEntity[];
  map_state: SnapshotEntity | null;
  attempts: SnapshotEntity[];
  leases: Lease[];
  process_receipts: SnapshotEntity[];
  recovery_receipts: SnapshotEntity[];
  checkpoints: Checkpoint[];
  last_sequence: number;
  last_event_hash: string;
  git_commit: string | null;
  artifact_hashes: Record<string, string>;
  outbox_pending: OutboxItem[];
  generated_at: string;
}

export interface SnapshotBuildInput {
  generated_at: string;
  git_commit: string | null;
  artifact_hashes: Record<string, string>;
}

export interface DurableTransaction {
  appendEvent(event: DomainEvent): Promise<StoredDomainEvent>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  claimTask(taskId: string, lease: Lease): Promise<boolean>;
  heartbeatAttempt(attemptId: string): Promise<void>;
  fenceAttempt(attemptId: string, reason: string): Promise<void>;
  enqueueOutbox(item: OutboxItem): Promise<void>;
}

export type StateTransaction<T> = (tx: DurableTransaction) => Promise<T> | T;

export interface StateStore {
  initialize(): Promise<void>;
  migrate(): Promise<void>;
  transaction<T>(fn: StateTransaction<T>): Promise<T>;
  appendEvent(event: DomainEvent): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  getActiveRun(): Promise<RunRecord | null>;
  getLatestRun(): Promise<RunRecord | null>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  claimTask(taskId: string, lease: Lease): Promise<boolean>;
  heartbeatAttempt(attemptId: string): Promise<void>;
  fenceAttempt(attemptId: string, reason: string): Promise<void>;
  enqueueOutbox(item: OutboxItem): Promise<void>;
  readPendingOutbox(): Promise<OutboxItem[]>;
  markOutboxProjected(id: string): Promise<void>;
  integrityCheck(): Promise<IntegrityResult>;
  createBackup(target: string): Promise<void>;
  rebuild(snapshot: DurableSnapshot, events: DomainEvent[]): Promise<void>;
  readEvents(afterSequence?: number): Promise<StoredDomainEvent[]>;
  exportSnapshot(input: SnapshotBuildInput): Promise<DurableSnapshot>;
  close(): Promise<void>;
}
