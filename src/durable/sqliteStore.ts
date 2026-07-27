import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { writeFileAtomic } from '../core/fsx.js';
import {
  canonicalJson,
  computeEventHash,
  redactDurableValue,
  sha256,
} from './canonical.js';
import { STATE_MIGRATIONS } from './migrations.js';
import { projectRunEvent } from './projection.js';
import {
  collectCanonicalArtifactHashes,
  writeDurableSnapshot,
} from './snapshot.js';
import { projectWorkflowState } from './sqliteProjection.js';
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
  type SnapshotEntity,
  type StateStore,
  type StateTransaction,
  type StoredDomainEvent,
} from './types.js';

type Database = BetterSqlite3.Database;
type DatabaseConstructor = new (
  filename?: string | Buffer,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => Database;

const require = createRequire(import.meta.url);
const MIN_SAFE_WAL = '3.51.3';
const NETWORK_FILESYSTEM_TYPES = new Set([
  0x6969, // NFS
  0xff534d42, // CIFS/SMB
  0x564c, // NCP
  0x1021994, // 9P
  0x73757245, // CODA
  0x5346414f, // AFS
]);

export class SqliteDriverLoadError extends Error {
  constructor(cause: unknown) {
    super(
      `RIJO cannot load the required SQLite driver better-sqlite3@12.10.0 for ` +
        `Node ${process.versions.node} on ${process.platform}/${process.arch}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. Persistence was not simulated.`,
    );
    this.name = 'SqliteDriverLoadError';
  }
}

export interface SqliteStateStoreOptions {
  projectRoot: string;
  dbPath?: string;
  busyTimeoutMs?: number;
  filesystem?: 'auto' | 'local' | 'network';
  now?: () => Date;
  /** Engine supervisor connections share the ledger but do not own the engine writer lease. */
  acquireWriterLock?: boolean;
  backupRetention?: {
    task?: number;
    phase?: number;
  };
}

export interface SqliteDiagnostics {
  sqlite_version: string;
  schema_version: number;
  foreign_keys: boolean;
  synchronous: 'FULL' | string;
  busy_timeout_ms: number;
  journal_mode: 'wal' | 'delete' | string;
  filesystem_local: boolean;
  wal_safe: boolean;
}

interface EventRow {
  sequence: number;
  event_id: string;
  run_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  payload: string;
  previous_event_hash: string;
  event_hash: string;
  created_at: string;
  idempotency_key: string;
}

interface OutboxRow extends Omit<OutboxItem, 'content'> {
  content: string | null;
}

function loadDriver(): DatabaseConstructor {
  try {
    return require('better-sqlite3') as DatabaseConstructor;
  } catch (error) {
    throw new SqliteDriverLoadError(error);
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function safeJsonParse(value: string | null): unknown {
  if (value === null) return undefined;
  return JSON.parse(value);
}

function toStoredEvent(row: EventRow): StoredDomainEvent {
  return {
    ...row,
    payload: JSON.parse(row.payload),
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

function runFromRow(row: RunRecord | undefined): RunRecord | null {
  return row ?? null;
}

export class SqliteStateStore implements StateStore {
  readonly projectRoot: string;
  readonly dbPath: string;
  readonly stateDir: string;
  readonly backupsDir: string;
  readonly migrationsDir: string;

  private db: Database | null = null;
  private diagnosticsValue: SqliteDiagnostics | null = null;
  private ownerId = randomUUID();
  private transactionTail: Promise<void> = Promise.resolve();
  private readonly busyTimeoutMs: number;
  private readonly filesystemMode: 'auto' | 'local' | 'network';
  private readonly now: () => Date;
  private readonly shouldAcquireWriterLock: boolean;
  private readonly taskBackupRetention: number;
  private readonly phaseBackupRetention: number;

  constructor(options: SqliteStateStoreOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.stateDir = path.join(this.projectRoot, '.rijo', 'state');
    this.dbPath = options.dbPath ?? path.join(this.stateDir, 'rijo.db');
    this.backupsDir = path.join(this.stateDir, 'backups');
    this.migrationsDir = path.join(this.stateDir, 'migrations');
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.filesystemMode = options.filesystem ?? 'auto';
    this.now = options.now ?? (() => new Date());
    this.shouldAcquireWriterLock = options.acquireWriterLock ?? true;
    this.taskBackupRetention = options.backupRetention?.task ?? 5;
    this.phaseBackupRetention = options.backupRetention?.phase ?? 3;
  }

  async initialize(): Promise<void> {
    if (this.db?.open) return;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.migrationsDir, { recursive: true, mode: 0o700 });

    const Driver = loadDriver();
    try {
      this.db = new Driver(this.dbPath);
    } catch (error) {
      throw new SqliteDriverLoadError(error);
    }
    if (process.platform !== 'win32') fs.chmodSync(this.dbPath, 0o600);

    const db = this.requireDb();
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
    db.pragma('synchronous = FULL');

    const sqliteVersion = (
      db.prepare(`SELECT sqlite_version() AS version`).get() as { version: string }
    ).version;
    const filesystemLocal = this.isLocalFilesystem();
    const walSafe = filesystemLocal && compareVersions(sqliteVersion, MIN_SAFE_WAL) >= 0;
    const journalMode = String(
      db.pragma(`journal_mode = ${walSafe ? 'WAL' : 'DELETE'}`, { simple: true }),
    ).toLowerCase();
    if (journalMode === 'wal') {
      db.pragma('wal_autocheckpoint = 1000');
    }

    await this.migrate();
    if (this.shouldAcquireWriterLock) this.acquireWriterLock();
    this.diagnosticsValue = {
      sqlite_version: sqliteVersion,
      schema_version: Number(db.pragma('user_version', { simple: true })),
      foreign_keys: Number(db.pragma('foreign_keys', { simple: true })) === 1,
      synchronous: this.synchronousName(Number(db.pragma('synchronous', { simple: true }))),
      busy_timeout_ms: Number(db.pragma('busy_timeout', { simple: true })),
      journal_mode: journalMode,
      filesystem_local: filesystemLocal,
      wal_safe: walSafe,
    };

    const integrity = await this.integrityCheck();
    if (!integrity.ok) {
      throw new Error(`Durable state integrity/hash chain failure: ${integrity.errors.join('; ')}`);
    }
  }

  async migrate(): Promise<void> {
    const db = this.requireDb();
    const found = Number(db.pragma('user_version', { simple: true }));
    if (found > STATE_SCHEMA_VERSION) {
      throw new Error(
        `State database version ${found} is newer than this RIJO build supports (${STATE_SCHEMA_VERSION}).`,
      );
    }

    const pending = STATE_MIGRATIONS.filter((item) => item.version > found);
    if (found > 0 && pending.length > 0) {
      await this.prepareMigrationBoundary(found);
    }

    for (const migration of pending) {
      const migrationFile = path.join(
        this.migrationsDir,
        `${String(migration.version).padStart(3, '0')}-${migration.name}.sql`,
      );
      writeFileAtomic(migrationFile, `${migration.sql}\n`);
      const checksum = sha256(migration.sql);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(migration.sql);
        db.prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        ).run(migration.version, migration.name, checksum, this.now().toISOString());
        db.pragma(`user_version = ${migration.version}`);
        db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
          String(migration.version),
        );
        db.exec('COMMIT');
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
      }
    }
    if (found > 0 && pending.length > 0) {
      const integrity = await this.integrityCheck();
      if (!integrity.ok) {
        throw new Error(
          `State migration validation failed: ${integrity.errors.join('; ')}`,
        );
      }
      const generatedAt = this.now().toISOString();
      const snapshot = await this.exportSnapshot({
        generated_at: generatedAt,
        git_commit: null,
        artifact_hashes: collectCanonicalArtifactHashes(this.projectRoot),
      });
      writeDurableSnapshot(this.projectRoot, snapshot);
    }
  }

  private async prepareMigrationBoundary(found: number): Promise<void> {
    const integrity = await this.integrityCheck();
    if (!integrity.ok) {
      throw new Error(
        `Refusing state migration from v${found}: ${integrity.errors.join('; ')}`,
      );
    }
    const generatedAt = this.now().toISOString();
    const stamp = generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
    await this.createBackup(
      path.join(this.backupsDir, `pre-migration-v${found}-${stamp}.sqlite`),
    );
    const snapshot = await this.exportSnapshot({
      generated_at: generatedAt,
      git_commit: null,
      artifact_hashes: collectCanonicalArtifactHashes(this.projectRoot),
    });
    writeDurableSnapshot(this.projectRoot, {
      ...snapshot,
      schema_version: found,
    });
  }

  async transaction<T>(fn: StateTransaction<T>): Promise<T> {
    const prior = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    const db = this.requireDb();
    db.exec('BEGIN IMMEDIATE');
    db.pragma('defer_foreign_keys = ON');
    try {
      const result = await fn(this.transactionView());
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    } finally {
      release();
    }
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    await this.transaction((tx) => tx.appendEvent(event));
  }

  /**
   * ProgressBus hot path: better-sqlite3 commits before this method returns, so
   * a following process crash cannot lose an already rendered transition.
   */
  appendEventImmediate(event: DomainEvent): StoredDomainEvent {
    const db = this.requireDb();
    if (db.inTransaction) {
      throw new Error('Cannot append an immediate event inside another state transaction');
    }
    db.exec('BEGIN IMMEDIATE');
    db.pragma('defer_foreign_keys = ON');
    try {
      const stored = this.appendEventInternal(event);
      db.exec('COMMIT');
      return stored;
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return runFromRow(
      this.requireDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as
        | RunRecord
        | undefined,
    );
  }

  async getActiveRun(): Promise<RunRecord | null> {
    return runFromRow(
      this.requireDb()
        .prepare(
          `SELECT * FROM runs WHERE status IN ('CREATED','RUNNING')
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get() as RunRecord | undefined,
    );
  }

  async getLatestRun(): Promise<RunRecord | null> {
    return runFromRow(
      this.requireDb()
        .prepare(`SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1`)
        .get() as RunRecord | undefined,
    );
  }

  readProgressMarker(): { sequence: number; observed_at: string } {
    const db = this.requireDb();
    const row = db
      .prepare(`SELECT sequence, created_at FROM events ORDER BY sequence DESC LIMIT 1`)
      .get() as { sequence: number; created_at: string } | undefined;
    const heartbeat = db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(created_at) AS created_at
         FROM process_receipts
         WHERE process_type = 'rijo-engine' AND action = 'engine.heartbeat'`,
      )
      .get() as { count: number; created_at: string | null };
    return {
      sequence:
        (row?.sequence ?? Number(this.readMeta('snapshot_last_sequence') ?? '0')) +
        Number(heartbeat.count),
      observed_at:
        [row?.created_at, heartbeat.created_at]
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? new Date(0).toISOString(),
    };
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
    const rows = this.requireDb()
      .prepare(`SELECT * FROM outbox WHERE status = 'PENDING' ORDER BY event_sequence, id`)
      .all() as OutboxRow[];
    return rows.map((row) => ({
      ...row,
      content: safeJsonParse(row.content),
    }));
  }

  async markOutboxProjected(id: string): Promise<void> {
    await this.transaction(async () => {
      this.requireDb()
        .prepare(
          `UPDATE outbox
           SET status = 'PROJECTED',
               attempts = attempts + CASE WHEN status = 'PROJECTED' THEN 0 ELSE 1 END,
               projected_at = COALESCE(projected_at, ?),
               last_error = NULL
           WHERE id = ?`,
        )
        .run(this.now().toISOString(), id);
    });
  }

  async integrityCheck(): Promise<IntegrityResult> {
    const db = this.requireDb();
    const quickCheck = String(db.pragma('quick_check', { simple: true }) ?? 'unknown');
    const integrityCheck = String(db.pragma('integrity_check', { simple: true }) ?? 'unknown');
    const errors: string[] = [];
    if (quickCheck.toLowerCase() !== 'ok') errors.push(`quick_check: ${quickCheck}`);
    if (integrityCheck.toLowerCase() !== 'ok') errors.push(`integrity_check: ${integrityCheck}`);

    const baselineSequence = Number(this.readMeta('snapshot_last_sequence') ?? '0');
    let previousHash = this.readMeta('snapshot_last_event_hash') ?? '';
    let expectedSequence = baselineSequence + 1;
    for (const event of await this.readEvents(baselineSequence)) {
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
    const projectedSequence = Number(
      (
        db.prepare(`SELECT COALESCE(MAX(last_event_sequence), ?) AS sequence FROM runs`)
          .get(baselineSequence) as { sequence: number }
      ).sequence,
    );
    if (projectedSequence !== expectedSequence - 1) {
      errors.push(
        `event truncation detected: projections reached ${projectedSequence}, chain reached ${expectedSequence - 1}`,
      );
    }

    return {
      ok: errors.length === 0,
      quick_check: quickCheck,
      integrity_check: integrityCheck,
      schema_version: Number(db.pragma('user_version', { simple: true })),
      last_event_sequence: expectedSequence - 1,
      last_event_hash: previousHash,
      errors,
    };
  }

  async createBackup(target: string): Promise<void> {
    const db = this.requireDb();
    const resolved = path.resolve(target);
    if (resolved === path.resolve(this.dbPath)) throw new Error('Backup target must differ from rijo.db');
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    const journalMode = String(db.pragma('journal_mode', { simple: true })).toLowerCase();
    if (journalMode === 'wal') db.pragma('wal_checkpoint(TRUNCATE)');
    await db.backup(resolved);
    if (process.platform !== 'win32') fs.chmodSync(resolved, 0o600);
    const Driver = loadDriver();
    const copy = new Driver(resolved, { readonly: true, fileMustExist: true });
    try {
      const check = String(copy.pragma('integrity_check', { simple: true }) ?? 'unknown');
      if (check.toLowerCase() !== 'ok') {
        fs.rmSync(resolved, { force: true });
        throw new Error(`SQLite backup failed integrity_check: ${check}`);
      }
    } finally {
      copy.close();
    }
    this.pruneBackups();
  }

  private pruneBackups(): void {
    const db = this.requireDb();
    const keep = new Set<number>();
    const checkpointRows = db
      .prepare(
        `SELECT event_sequence, kind FROM checkpoints
         ORDER BY event_sequence DESC`,
      )
      .all() as Array<{ event_sequence: number; kind: string }>;
    for (const kind of ['MILESTONE', 'TERMINAL']) {
      for (const row of checkpointRows.filter((item) => item.kind === kind)) {
        keep.add(row.event_sequence);
      }
    }
    for (const row of checkpointRows
      .filter((item) => item.kind === 'TASK')
      .slice(0, this.taskBackupRetention)) {
      keep.add(row.event_sequence);
    }
    for (const row of checkpointRows
      .filter((item) => item.kind === 'PHASE')
      .slice(0, this.phaseBackupRetention)) {
      keep.add(row.event_sequence);
    }
    const terminal = db
      .prepare(
        `SELECT last_event_sequence FROM runs
         WHERE status IN ('READY','NOT_READY','BLOCKED')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as { last_event_sequence: number } | undefined;
    if (terminal) keep.add(terminal.last_event_sequence);

    const backups = fs
      .readdirSync(this.backupsDir)
      .map((name) => ({
        name,
        sequence: Number(name.match(/^(\d+)-/)?.[1] ?? Number.NaN),
      }))
      .filter((item) => Number.isFinite(item.sequence))
      .sort((left, right) => right.sequence - left.sequence);
    if (backups[0]) keep.add(backups[0].sequence);
    for (const backup of backups) {
      if (!keep.has(backup.sequence)) {
        fs.rmSync(path.join(this.backupsDir, backup.name), { force: true });
      }
    }
  }

  async rebuild(snapshot: DurableSnapshot, events: DomainEvent[]): Promise<void> {
    await this.transaction(async (tx) => {
      const db = this.requireDb();
      for (const table of [
        'decision_evidence',
        'artifact_hashes',
        'task_dependencies',
        'outbox',
        'checkpoints',
        'leases',
        'agent_attempts',
        'decisions',
        'command_evidence',
        'map_versions',
        'artifacts',
        'events',
        'tasks',
        'requirements',
        'phases',
        'milestones',
        'runs',
        'process_receipts',
        'recovery_receipts',
      ]) {
        db.exec(`DELETE FROM ${table}`);
      }
      this.writeMeta('snapshot_last_sequence', String(snapshot.last_sequence));
      this.writeMeta('snapshot_last_event_hash', snapshot.last_event_hash);
      if (snapshot.run) this.insertSnapshotRow('runs', snapshot.run as unknown as SnapshotEntity);
      for (const row of snapshot.milestones) this.insertSnapshotRow('milestones', row);
      for (const row of snapshot.phases) this.insertSnapshotRow('phases', row);
      for (const row of snapshot.requirements) this.insertSnapshotRow('requirements', row);
      for (const row of snapshot.tasks) this.insertSnapshotRow('tasks', row);
      for (const row of snapshot.attempts) this.insertSnapshotRow('agent_attempts', row);
      for (const row of snapshot.decisions) this.insertSnapshotRow('decisions', row);
      for (const row of snapshot.command_evidence) {
        this.insertSnapshotRow('command_evidence', row);
      }
      if (snapshot.map_state) this.insertSnapshotRow('map_versions', snapshot.map_state);
      for (const row of snapshot.leases) {
        this.insertSnapshotRow('leases', row as unknown as SnapshotEntity);
      }
      for (const row of snapshot.checkpoints) {
        this.insertSnapshotRow('checkpoints', row as unknown as SnapshotEntity);
      }
      for (const row of snapshot.process_receipts) {
        this.insertSnapshotRow('process_receipts', row);
      }
      for (const row of snapshot.recovery_receipts) {
        this.insertSnapshotRow('recovery_receipts', row);
      }
      for (const row of snapshot.outbox_pending) {
        await tx.enqueueOutbox(row);
      }
      for (const event of events) await tx.appendEvent(event);
    });
    const integrity = await this.integrityCheck();
    if (!integrity.ok) throw new Error(`Rebuilt state failed integrity: ${integrity.errors.join('; ')}`);
  }

  async readEvents(afterSequence = 0): Promise<StoredDomainEvent[]> {
    const rows = this.requireDb()
      .prepare(`SELECT * FROM events WHERE sequence > ? ORDER BY sequence`)
      .all(afterSequence) as EventRow[];
    return rows.map(toStoredEvent);
  }

  async exportSnapshot(input: SnapshotBuildInput): Promise<DurableSnapshot> {
    const db = this.requireDb();
    const integrity = await this.integrityCheck();
    const run =
      (await this.getActiveRun()) ??
      runFromRow(db.prepare(`SELECT * FROM runs ORDER BY updated_at DESC LIMIT 1`).get() as RunRecord | undefined);
    const milestones = this.rows('milestones');
    const phases = this.rows('phases');
    const tasks = this.rows('tasks');
    return {
      schema_version: STATE_SCHEMA_VERSION,
      run,
      active_milestone:
        milestones.find((item) => item['id'] === run?.active_milestone) ?? null,
      active_phase:
        phases.find(
          (item) =>
            item['id'] === run?.active_phase &&
            (run?.active_milestone === null || item['milestone_id'] === run?.active_milestone),
        ) ?? null,
      active_task: tasks.find((item) => item['logical_task_id'] === run?.active_task) ?? null,
      milestones,
      phases,
      requirements: this.rows('requirements'),
      roadmap: phases,
      tasks,
      decisions: this.rows('decisions'),
      command_evidence: this.rows('command_evidence'),
      map_state:
        (db.prepare(`SELECT * FROM map_versions ORDER BY created_at DESC LIMIT 1`).get() as
          | SnapshotEntity
          | undefined) ?? null,
      attempts: this.rows('agent_attempts'),
      leases: this.rows('leases') as unknown as Lease[],
      process_receipts: this.rows('process_receipts'),
      recovery_receipts: this.rows('recovery_receipts'),
      checkpoints: this.rows('checkpoints') as unknown as Checkpoint[],
      last_sequence: integrity.last_event_sequence,
      last_event_hash: integrity.last_event_hash,
      git_commit: input.git_commit,
      artifact_hashes: { ...input.artifact_hashes },
      outbox_pending: await this.readPendingOutbox(),
      generated_at: input.generated_at,
    };
  }

  diagnostics(): SqliteDiagnostics {
    if (!this.diagnosticsValue) throw new Error('SqliteStateStore is not initialized');
    return { ...this.diagnosticsValue };
  }

  async close(): Promise<void> {
    const db = this.db;
    if (!db?.open) return;
    try {
      if (this.diagnosticsValue?.journal_mode === 'wal') db.pragma('wal_checkpoint(TRUNCATE)');
      const hasLocks = db
        .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'locks'`)
        .get();
      if (hasLocks && this.shouldAcquireWriterLock) {
        db.prepare(`DELETE FROM locks WHERE name = 'rijo-writer' AND owner_id = ?`).run(
          this.ownerId,
        );
      }
    } finally {
      db.close();
      this.db = null;
      this.diagnosticsValue = null;
    }
  }

  private requireDb(): Database {
    if (!this.db?.open) throw new Error('SqliteStateStore is not initialized');
    return this.db;
  }

  private transactionView(): DurableTransaction {
    return {
      appendEvent: async (event) => this.appendEventInternal(event),
      saveCheckpoint: async (checkpoint) => this.saveCheckpointInternal(checkpoint),
      claimTask: async (taskId, lease) => this.claimTaskInternal(taskId, lease),
      heartbeatAttempt: async (attemptId) => this.heartbeatAttemptInternal(attemptId),
      fenceAttempt: async (attemptId, reason) => this.fenceAttemptInternal(attemptId, reason),
      enqueueOutbox: async (item) => this.enqueueOutboxInternal(item),
    };
  }

  private appendEventInternal(raw: DomainEvent): StoredDomainEvent {
    const db = this.requireDb();
    const duplicate = db
      .prepare(`SELECT * FROM events WHERE idempotency_key = ?`)
      .get(raw.idempotency_key) as EventRow | undefined;
    if (duplicate) return toStoredEvent(duplicate);

    const last = db.prepare(`SELECT sequence, event_hash FROM events ORDER BY sequence DESC LIMIT 1`).get() as
      | { sequence: number; event_hash: string }
      | undefined;
    const baselineSequence = Number(this.readMeta('snapshot_last_sequence') ?? '0');
    const baselineHash = this.readMeta('snapshot_last_event_hash') ?? '';
    const sequence = (last?.sequence ?? baselineSequence) + 1;
    const previousHash = last?.event_hash ?? baselineHash;
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
    db.prepare(
      `INSERT INTO events (
         sequence, event_id, run_id, aggregate_type, aggregate_id, event_type,
         schema_version, payload, previous_event_hash, event_hash, created_at, idempotency_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.sequence,
      event.event_id,
      event.run_id,
      event.aggregate_type,
      event.aggregate_id,
      event.event_type,
      event.schema_version,
      canonicalJson(event.payload),
      event.previous_event_hash,
      event.event_hash,
      event.created_at,
      event.idempotency_key,
    );

    const current = runFromRow(
      db.prepare(`SELECT * FROM runs WHERE id = ?`).get(event.run_id) as RunRecord | undefined,
    );
    const projected = projectRunEvent(current, event);
    if (!projected && event.event_type !== 'run.created') {
      throw new Error(`Event ${event.event_type} references missing run ${event.run_id}`);
    }
    if (projected) this.upsertRun(projected);
    projectWorkflowState(db, event);
    this.enqueueOutboxInternal(defaultOutbox(event));
    return event;
  }

  private upsertRun(run: RunRecord): void {
    this.requireDb()
      .prepare(
        `INSERT INTO runs (
           id, plan_hash, host, status, created_at, updated_at, started_commit,
           final_commit, active_milestone, active_phase, active_task,
           last_event_sequence, terminal_reason
         ) VALUES (
           @id, @plan_hash, @host, @status, @created_at, @updated_at, @started_commit,
           @final_commit, @active_milestone, @active_phase, @active_task,
           @last_event_sequence, @terminal_reason
         )
         ON CONFLICT(id) DO UPDATE SET
           plan_hash=excluded.plan_hash, host=excluded.host, status=excluded.status,
           updated_at=excluded.updated_at, started_commit=excluded.started_commit,
           final_commit=excluded.final_commit, active_milestone=excluded.active_milestone,
           active_phase=excluded.active_phase, active_task=excluded.active_task,
           last_event_sequence=excluded.last_event_sequence,
           terminal_reason=excluded.terminal_reason`,
      )
      .run(run);
  }

  private saveCheckpointInternal(raw: Checkpoint): void {
    const checkpoint = redactDurableValue(raw) as Checkpoint;
    this.requireDb()
      .prepare(
        `INSERT OR IGNORE INTO checkpoints (
          id, run_id, event_sequence, kind, git_commit, tree_hash, snapshot_hash,
          created_at, idempotency_key
        ) VALUES (@id, @run_id, @event_sequence, @kind, @git_commit, @tree_hash,
          @snapshot_hash, @created_at, @idempotency_key)`,
      )
      .run(checkpoint);
  }

  private claimTaskInternal(taskId: string, lease: Lease): boolean {
    const db = this.requireDb();
    const active = db
      .prepare(
        `SELECT id FROM leases
         WHERE logical_task_id = ? AND state = 'ACTIVE' AND id <> ? LIMIT 1`,
      )
      .get(taskId, lease.id);
    if (active) return false;
    db.prepare(
      `INSERT OR IGNORE INTO leases (
        id, run_id, logical_task_id, attempt_id, owner_id, generation, state,
        acquired_at, heartbeat_at, expires_at, fenced_at, fence_reason, idempotency_key
      ) VALUES (
        @id, @run_id, @logical_task_id, @attempt_id, @owner_id, @generation, @state,
        @acquired_at, @heartbeat_at, @expires_at, @fenced_at, @fence_reason, @idempotency_key
      )`,
    ).run(lease);
    return true;
  }

  private heartbeatAttemptInternal(attemptId: string): void {
    const now = this.now().toISOString();
    this.requireDb().prepare(`UPDATE agent_attempts SET last_heartbeat = ? WHERE attempt_id = ?`).run(
      now,
      attemptId,
    );
    this.requireDb().prepare(`UPDATE leases SET heartbeat_at = ? WHERE attempt_id = ? AND state = 'ACTIVE'`).run(
      now,
      attemptId,
    );
  }

  private fenceAttemptInternal(attemptId: string, reason: string): void {
    const now = this.now().toISOString();
    this.requireDb()
      .prepare(
        `UPDATE leases SET state = 'REVOKED', fenced_at = ?, fence_reason = ?
         WHERE attempt_id = ? AND state = 'ACTIVE'`,
      )
      .run(now, reason, attemptId);
    this.requireDb()
      .prepare(
        `UPDATE agent_attempts
         SET state = CASE WHEN state IN ('SUCCEEDED','FAILED','EXHAUSTED') THEN state ELSE 'FENCED' END,
             finished_at = COALESCE(finished_at, ?)
         WHERE attempt_id = ?`,
      )
      .run(now, attemptId);
  }

  private enqueueOutboxInternal(raw: OutboxItem): void {
    const item = redactDurableValue(raw) as OutboxItem;
    this.requireDb()
      .prepare(
        `INSERT OR IGNORE INTO outbox (
          id, event_sequence, projection_type, destination, content_hash, content,
          status, attempts, last_error, created_at, projected_at
        ) VALUES (
          @id, @event_sequence, @projection_type, @destination, @content_hash, @content,
          @status, @attempts, @last_error, @created_at, @projected_at
        )`,
      )
      .run({
        ...item,
        content: item.content === undefined ? null : canonicalJson(item.content),
      });
  }

  private acquireWriterLock(): void {
    const db = this.requireDb();
    const existing = db
      .prepare(`SELECT owner_id, pid FROM locks WHERE name = 'rijo-writer'`)
      .get() as { owner_id: string; pid: number } | undefined;
    if (existing && existing.owner_id !== this.ownerId && pidAlive(existing.pid)) {
      throw new Error(
        `Another RIJO writer is active for this project (pid ${existing.pid}, owner ${existing.owner_id}).`,
      );
    }
    const now = this.now().toISOString();
    db.prepare(
      `INSERT INTO locks (name, owner_id, pid, process_group, acquired_at, heartbeat_at, expires_at)
       VALUES ('rijo-writer', ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id, pid=excluded.pid,
         process_group=excluded.process_group, acquired_at=excluded.acquired_at,
         heartbeat_at=excluded.heartbeat_at, expires_at=NULL`,
    ).run(this.ownerId, process.pid, process.pid, now, now);
  }

  private isLocalFilesystem(): boolean {
    if (this.filesystemMode === 'local') return true;
    if (this.filesystemMode === 'network') return false;
    if (process.platform === 'win32') {
      // Node does not expose GetDriveType. Fail closed when explicitly marked
      // network; otherwise local fixed disks are the overwhelmingly common case.
      return !this.dbPath.startsWith('\\\\');
    }
    try {
      const type = Number(fs.statfsSync(path.dirname(this.dbPath)).type);
      return !NETWORK_FILESYSTEM_TYPES.has(type);
    } catch {
      return false;
    }
  }

  private synchronousName(value: number): string {
    return ({ 0: 'OFF', 1: 'NORMAL', 2: 'FULL', 3: 'EXTRA' } as Record<number, string>)[value] ?? String(value);
  }

  private readMeta(key: string): string | null {
    const row = this.requireDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.requireDb()
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  private rows(table: 'milestones' | 'phases' | 'requirements' | 'tasks' | 'decisions' | 'command_evidence' | 'agent_attempts' | 'leases' | 'checkpoints' | 'process_receipts' | 'recovery_receipts'): SnapshotEntity[] {
    return this.requireDb().prepare(`SELECT * FROM ${table}`).all() as SnapshotEntity[];
  }

  private insertSnapshotRow(
    table:
      | 'runs'
      | 'milestones'
      | 'phases'
      | 'requirements'
      | 'tasks'
      | 'agent_attempts'
      | 'decisions'
      | 'command_evidence'
      | 'leases'
      | 'checkpoints'
      | 'map_versions'
      | 'process_receipts'
      | 'recovery_receipts',
    raw: SnapshotEntity,
  ): void {
    const row = redactDurableValue(raw) as Record<string, unknown>;
    const columns = (
      this.requireDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    )
      .map((item) => item.name)
      .filter((name) => Object.hasOwn(row, name));
    if (columns.length === 0) return;
    const parameters = Object.fromEntries(
      columns.map((column) => [
        column,
        row[column] !== null && typeof row[column] === 'object'
          ? canonicalJson(row[column])
          : row[column],
      ]),
    );
    this.requireDb()
      .prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns
          .map((column) => `@${column}`)
          .join(',')})`,
      )
      .run(parameters);
  }

  async acquireNamedLock(name: string, ownerId: string, pid: number): Promise<boolean> {
    return this.transaction(async () => {
      const db = this.requireDb();
      const existing = db.prepare(`SELECT owner_id, pid FROM locks WHERE name = ?`).get(name) as
        | { owner_id: string; pid: number }
        | undefined;
      if (existing && existing.owner_id !== ownerId && pidAlive(existing.pid)) return false;
      const now = this.now().toISOString();
      db.prepare(
        `INSERT INTO locks (name, owner_id, pid, process_group, acquired_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET owner_id=excluded.owner_id, pid=excluded.pid,
           process_group=excluded.process_group, acquired_at=excluded.acquired_at,
           heartbeat_at=excluded.heartbeat_at, expires_at=NULL`,
      ).run(name, ownerId, pid, process.platform === 'win32' ? null : pid, now, now);
      return true;
    });
  }

  async releaseNamedLock(name: string, ownerId: string): Promise<void> {
    await this.transaction(async () => {
      this.requireDb().prepare(`DELETE FROM locks WHERE name = ? AND owner_id = ?`).run(name, ownerId);
    });
  }

  async appendProcessReceipt(receipt: {
    id: string;
    run_id: string | null;
    process_type: string;
    pid: number | null;
    process_group: number | null;
    action: string;
    payload: unknown;
    idempotency_key: string;
    created_at: string;
  }): Promise<void> {
    await this.transaction(async () => {
      const safe = redactDurableValue(receipt) as typeof receipt;
      this.requireDb().prepare(
        `INSERT OR IGNORE INTO process_receipts (
          id, run_id, process_type, pid, process_group, action, payload,
          idempotency_key, created_at
        ) VALUES (
          @id, @run_id, @process_type, @pid, @process_group, @action, @payload,
          @idempotency_key, @created_at
        )`,
      ).run({ ...safe, payload: canonicalJson(safe.payload) });
    });
  }

  async appendRecoveryReceipt(receipt: {
    id: string;
    run_id: string | null;
    recovery_type: string;
    source_hash: string | null;
    result_hash: string | null;
    payload: unknown;
    idempotency_key: string;
    created_at: string;
  }): Promise<void> {
    await this.transaction(async () => {
      const safe = redactDurableValue(receipt) as typeof receipt;
      this.requireDb().prepare(
        `INSERT OR IGNORE INTO recovery_receipts (
          id, run_id, recovery_type, source_hash, result_hash, payload,
          idempotency_key, created_at
        ) VALUES (
          @id, @run_id, @recovery_type, @source_hash, @result_hash, @payload,
          @idempotency_key, @created_at
        )`,
      ).run({ ...safe, payload: canonicalJson(safe.payload) });
    });
  }

  async readLastProcessReceipts(processType: string): Promise<SnapshotEntity[]> {
    return this.requireDb()
      .prepare(`SELECT * FROM process_receipts WHERE process_type = ? ORDER BY created_at, id`)
      .all(processType) as SnapshotEntity[];
  }

  async fenceAllActiveAttempts(reason: string): Promise<void> {
    await this.transaction(async () => {
      const now = this.now().toISOString();
      this.requireDb()
        .prepare(
          `UPDATE leases SET state='REVOKED', fenced_at=?, fence_reason=?
           WHERE state='ACTIVE'`,
        )
        .run(now, reason);
      this.requireDb()
        .prepare(
          `UPDATE agent_attempts SET state='FENCED', finished_at=COALESCE(finished_at, ?)
           WHERE state NOT IN ('SUCCEEDED','FAILED','EXHAUSTED','FENCED')`,
        )
        .run(now);
    });
  }
}
