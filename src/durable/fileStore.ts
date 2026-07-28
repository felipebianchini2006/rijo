import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../core/fsx.js';
import { canonicalJson, sha256 } from './canonical.js';
import { MemoryStateStore, type SerializedMemoryState } from './memoryStore.js';
import { readEventSegments } from './segments.js';
import { readLatestSnapshot } from './snapshot.js';
import type {
  Checkpoint,
  DomainEvent,
  DurableSnapshot,
  DurableTransaction,
  IntegrityResult,
  Lease,
  OutboxItem,
  RunRecord,
  SnapshotBuildInput,
  StateStore,
  StateTransaction,
  StoredDomainEvent,
} from './types.js';

interface FileStateEnvelope {
  format: 'RIJO_FILE_STATE';
  version: 1;
  checksum: string;
  data: SerializedMemoryState;
}

interface FileOperationalState {
  version: 1;
  locks: Record<string, { owner_id: string; pid: number }>;
  process_receipts: Array<Record<string, unknown>>;
  recovery_receipts: Array<Record<string, unknown>>;
}

export interface FileStateStoreOptions {
  projectRoot: string;
  statePath?: string;
}

function envelopeFor(data: SerializedMemoryState): FileStateEnvelope {
  return {
    format: 'RIJO_FILE_STATE',
    version: 1,
    checksum: sha256(canonicalJson(data)),
    data,
  };
}

function verifyEnvelope(raw: unknown): FileStateEnvelope {
  if (!raw || typeof raw !== 'object') throw new Error('File state snapshot is not an object.');
  const value = raw as Partial<FileStateEnvelope>;
  if (value.format !== 'RIJO_FILE_STATE' || value.version !== 1 || !value.data) {
    throw new Error('File state snapshot has an unsupported format.');
  }
  if (value.checksum !== sha256(canonicalJson(value.data))) {
    throw new Error('File state snapshot checksum mismatch.');
  }
  return value as FileStateEnvelope;
}

/**
 * Persistent StateStore fallback.
 *
 * The operational image is atomic and ignored by Git. Recovery prefers the
 * canonical ledger snapshot and event segments. It can also replay the
 * portable .rijo/events.jsonl projection in a clean clone.
 */
export class FileStateStore implements StateStore {
  private readonly memory = new MemoryStateStore();
  private readonly statePath: string;
  private readonly operationsPath: string;
  private initialized = false;

  constructor(private readonly options: FileStateStoreOptions) {
    this.statePath =
      options.statePath ??
      path.join(path.resolve(options.projectRoot), '.rijo', 'state', 'file-store.json');
    this.operationsPath = path.join(
      path.dirname(this.statePath),
      'file-operations.json',
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.memory.initialize();
    if (fs.existsSync(this.statePath)) {
      try {
        const raw = readJsonIfExists(this.statePath);
        if (raw === null) throw new Error('File state snapshot disappeared during recovery.');
        this.memory.importData(verifyEnvelope(raw).data);
        this.initialized = true;
        return;
      } catch {
        this.preserveCorruptSnapshot();
      }
    }
    await this.rebuildFromPortableState();
    this.initialized = true;
    this.persist();
  }

  async migrate(): Promise<void> {
    await this.initialize();
    this.persist();
  }

  async transaction<T>(fn: StateTransaction<T>): Promise<T> {
    const result = await this.memory.transaction(fn);
    this.persist();
    return result;
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    await this.memory.appendEvent(event);
    this.persist();
  }

  appendEventImmediate(event: DomainEvent): StoredDomainEvent {
    const stored = this.memory.appendEventImmediate(event);
    this.persist();
    return stored;
  }

  getRun(runId: string): Promise<RunRecord | null> {
    return this.memory.getRun(runId);
  }

  getActiveRun(): Promise<RunRecord | null> {
    return this.memory.getActiveRun();
  }

  getLatestRun(): Promise<RunRecord | null> {
    return this.memory.getLatestRun();
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.memory.saveCheckpoint(checkpoint);
    this.persist();
  }

  async claimTask(taskId: string, lease: Lease): Promise<boolean> {
    const claimed = await this.memory.claimTask(taskId, lease);
    this.persist();
    return claimed;
  }

  async heartbeatAttempt(attemptId: string): Promise<void> {
    await this.memory.heartbeatAttempt(attemptId);
    this.persist();
  }

  async fenceAttempt(attemptId: string, reason: string): Promise<void> {
    await this.memory.fenceAttempt(attemptId, reason);
    this.persist();
  }

  async enqueueOutbox(item: OutboxItem): Promise<void> {
    await this.memory.enqueueOutbox(item);
    this.persist();
  }

  readPendingOutbox(): Promise<OutboxItem[]> {
    return this.memory.readPendingOutbox();
  }

  async markOutboxProjected(id: string): Promise<void> {
    await this.memory.markOutboxProjected(id);
    this.persist();
  }

  integrityCheck(): Promise<IntegrityResult> {
    return this.memory.integrityCheck();
  }

  async createBackup(target: string): Promise<void> {
    this.persist();
    const jsonTarget = target.endsWith('.sqlite') ? `${target}.json` : target;
    ensureDir(path.dirname(jsonTarget));
    writeFileAtomic(jsonTarget, fs.readFileSync(this.statePath, 'utf8'));
  }

  async rebuild(snapshot: DurableSnapshot, events: DomainEvent[]): Promise<void> {
    await this.memory.rebuild(snapshot, events);
    this.persist();
  }

  readEvents(afterSequence = 0): Promise<StoredDomainEvent[]> {
    return this.memory.readEvents(afterSequence);
  }

  exportSnapshot(input: SnapshotBuildInput): Promise<DurableSnapshot> {
    return this.memory.exportSnapshot(input);
  }

  async close(): Promise<void> {
    if (!this.initialized) return;
    this.persist();
    await this.memory.close();
    this.initialized = false;
  }

  async acquireNamedLock(name: string, ownerId: string, pid: number): Promise<boolean> {
    const state = this.readOperations();
    const active = state.locks[name];
    if (active && active.owner_id !== ownerId && processAlive(active.pid)) return false;
    state.locks[name] = { owner_id: ownerId, pid };
    this.writeOperations(state);
    return true;
  }

  async releaseNamedLock(name: string, ownerId: string): Promise<void> {
    const state = this.readOperations();
    if (state.locks[name]?.owner_id !== ownerId) return;
    delete state.locks[name];
    this.writeOperations(state);
  }

  async readProgressMarker(): Promise<{ sequence: number; observed_at: string }> {
    const run = await this.getLatestRun();
    return {
      sequence: run?.last_event_sequence ?? 0,
      observed_at: run?.updated_at ?? new Date(0).toISOString(),
    };
  }

  async readLastProcessReceipts(processType: string): Promise<Array<Record<string, unknown>>> {
    return this.readOperations().process_receipts.filter(
      (receipt) => receipt['process_type'] === processType,
    );
  }

  async appendProcessReceipt(receipt: Record<string, unknown>): Promise<void> {
    const state = this.readOperations();
    const key = String(receipt['idempotency_key'] ?? receipt['id'] ?? '');
    if (
      key &&
      state.process_receipts.some(
        (candidate) =>
          String(candidate['idempotency_key'] ?? candidate['id'] ?? '') === key,
      )
    ) {
      return;
    }
    state.process_receipts.push(receipt);
    this.writeOperations(state);
  }

  async appendRecoveryReceipt(receipt: Record<string, unknown>): Promise<void> {
    const state = this.readOperations();
    const key = String(receipt['idempotency_key'] ?? receipt['id'] ?? '');
    if (
      key &&
      state.recovery_receipts.some(
        (candidate) =>
          String(candidate['idempotency_key'] ?? candidate['id'] ?? '') === key,
      )
    ) {
      return;
    }
    state.recovery_receipts.push(receipt);
    this.writeOperations(state);
  }

  async fenceAllActiveAttempts(reason: string): Promise<void> {
    const snapshot = await this.exportSnapshot({
      generated_at: new Date().toISOString(),
      git_commit: null,
      artifact_hashes: {},
    });
    for (const lease of snapshot.leases) {
      if (lease.state === 'ACTIVE' && lease.attempt_id) {
        await this.fenceAttempt(lease.attempt_id, reason);
      }
    }
  }

  private persist(): void {
    if (!this.initialized && !this.memory.exportData().initialized) return;
    writeJsonAtomic(this.statePath, envelopeFor(this.memory.exportData()));
  }

  private preserveCorruptSnapshot(): void {
    if (!fs.existsSync(this.statePath)) return;
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    fs.renameSync(this.statePath, `${this.statePath}.corrupt-${stamp}`);
  }

  private async rebuildFromPortableState(): Promise<void> {
    const projectRoot = path.resolve(this.options.projectRoot);
    const snapshot = readLatestSnapshot(projectRoot);
    if (snapshot) {
      await this.memory.rebuild(snapshot, readEventSegments(projectRoot, snapshot.last_sequence));
      return;
    }
    const projection = path.join(projectRoot, '.rijo', 'events.jsonl');
    if (!fs.existsSync(projection)) return;
    for (const line of fs.readFileSync(projection, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const raw = JSON.parse(line) as Partial<StoredDomainEvent>;
      if (
        !raw.event_id ||
        !raw.run_id ||
        !raw.aggregate_type ||
        !raw.aggregate_id ||
        !raw.event_type ||
        !raw.created_at ||
        !raw.idempotency_key
      ) {
        continue;
      }
      this.memory.appendEventImmediate({
        event_id: raw.event_id,
        run_id: raw.run_id,
        aggregate_type: raw.aggregate_type,
        aggregate_id: raw.aggregate_id,
        event_type: raw.event_type,
        schema_version: raw.schema_version ?? 1,
        payload: raw.payload ?? {},
        created_at: raw.created_at,
        idempotency_key: raw.idempotency_key,
      });
    }
  }

  private readOperations(): FileOperationalState {
    const raw = readJsonIfExists<Partial<FileOperationalState>>(this.operationsPath);
    return {
      version: 1,
      locks: raw?.version === 1 && raw.locks ? raw.locks : {},
      process_receipts:
        raw?.version === 1 && Array.isArray(raw.process_receipts) ? raw.process_receipts : [],
      recovery_receipts:
        raw?.version === 1 && Array.isArray(raw.recovery_receipts) ? raw.recovery_receipts : [],
    };
  }

  private writeOperations(state: FileOperationalState): void {
    writeJsonAtomic(this.operationsPath, state);
  }
}

function processAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
