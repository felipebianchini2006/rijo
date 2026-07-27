import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteStateStore,
  STATE_MIGRATIONS,
  STATE_SCHEMA_VERSION,
  type DomainEvent,
} from '../src/durable/index.js';

const roots: string[] = [];

function fixture(): { root: string; db: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-durable-'));
  roots.push(root);
  return { root, db: path.join(root, '.rijo', 'state', 'rijo.db') };
}

function event(id = 'event-1'): DomainEvent {
  return {
    event_id: id,
    run_id: 'run-sqlite',
    aggregate_type: 'run',
    aggregate_id: 'run-sqlite',
    event_type: 'run.created',
    schema_version: 1,
    payload: { plan_hash: 'hash-1', host: 'codex', status: 'RUNNING' },
    created_at: '2026-07-27T12:00:00.000Z',
    idempotency_key: 'run-sqlite:create',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SqliteStateStore', () => {
  it('initializes the versioned schema, critical pragmas and restrictive permissions', async () => {
    const { root, db } = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();

    const diagnostics = store.diagnostics();
    expect(diagnostics.schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(diagnostics.foreign_keys).toBe(true);
    expect(diagnostics.synchronous).toBe('FULL');
    expect(diagnostics.busy_timeout_ms).toBeGreaterThanOrEqual(5_000);
    expect(['wal', 'delete']).toContain(diagnostics.journal_mode);
    expect(fs.existsSync(path.join(root, '.rijo', 'state', 'migrations', '001-initial.sql'))).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(db).mode & 0o777).toBe(0o600);

    const inspection = new Database(db, { readonly: true });
    const tables = inspection
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((row) => (row as { name: string }).name);
    for (const table of [
      'agent_attempts',
      'artifacts',
      'checkpoints',
      'command_evidence',
      'decision_evidence',
      'decisions',
      'events',
      'leases',
      'locks',
      'map_versions',
      'meta',
      'milestones',
      'outbox',
      'phases',
      'process_receipts',
      'recovery_receipts',
      'requirements',
      'runs',
      'schema_migrations',
      'task_dependencies',
      'tasks',
    ]) {
      expect(tables).toContain(table);
    }
    inspection.close();
    await store.close();
  });

  it('enforces foreign keys and unique event idempotency keys', async () => {
    const { root, db } = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent(event());
    await store.appendEvent(event('duplicate-id'));
    expect(await store.readEvents()).toHaveLength(1);
    await store.close();

    const raw = new Database(db);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO phases (id, milestone_id, status, created_at, updated_at)
           VALUES ('01', 'missing', 'PENDING', 'now', 'now')`,
        )
        .run(),
    ).toThrow();
    raw.close();
  });

  it('detects event-chain tampering', async () => {
    const { root, db } = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent(event());
    await store.close();

    const raw = new Database(db);
    raw.prepare(`UPDATE events SET payload = ? WHERE sequence = 1`).run('{"tampered":true}');
    raw.close();

    const reopened = new SqliteStateStore({ projectRoot: root });
    await expect(reopened.initialize()).rejects.toThrow(/hash chain|integrity/i);
    await reopened.close();
  });

  it('detects a truncated event tail even when remaining hashes are internally valid', async () => {
    const { root, db } = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent(event());
    await store.appendEvent({
      ...event('ready'),
      event_type: 'run.ready',
      payload: { final_commit: 'abc', terminal_reason: 'passed' },
      idempotency_key: 'run-sqlite:ready',
    });
    await store.close();

    const raw = new Database(db);
    raw.prepare(`DELETE FROM events WHERE sequence = 2`).run();
    raw.close();

    const reopened = new SqliteStateStore({ projectRoot: root });
    await expect(reopened.initialize()).rejects.toThrow(/truncat|sequence|integrity/i);
    await reopened.close();
  });

  it('never persists secrets embedded in otherwise safe payload fields', async () => {
    const { root, db } = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent({
      ...event(),
      payload: {
        plan_hash: 'hash-1',
        host: 'codex',
        summary: 'Bearer top.secret.value sk-proj-abcdefghijklmnop',
      },
    });
    await store.close();

    const bytes = fs.readFileSync(db).toString('utf8');
    expect(bytes).not.toContain('top.secret.value');
    expect(bytes).not.toContain('sk-proj-abcdefghijklmnop');
  });

  it('falls back to DELETE journal mode on a filesystem identified as network', async () => {
    const { root } = fixture();
    const store = new SqliteStateStore({ projectRoot: root, filesystem: 'network' });
    await store.initialize();
    expect(store.diagnostics()).toMatchObject({
      filesystem_local: false,
      wal_safe: false,
      journal_mode: 'delete',
    });
    await store.close();
  });

  it('rejects a second engine writer while allowing the supervisor connection', async () => {
    const { root } = fixture();
    const first = new SqliteStateStore({ projectRoot: root });
    await first.initialize();
    const second = new SqliteStateStore({ projectRoot: root });
    await expect(second.initialize()).rejects.toThrow(/writer is active/i);
    await second.close();

    const supervisor = new SqliteStateStore({
      projectRoot: root,
      acquireWriterLock: false,
    });
    await supervisor.initialize();
    await supervisor.close();
    await first.close();
  });

  it('creates a consistent SQLite backup after a controlled WAL checkpoint', async () => {
    const { root } = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent(event());
    const backup = path.join(root, '.rijo', 'state', 'backups', '000001.sqlite');

    await store.createBackup(backup);

    const copy = new Database(backup, { readonly: true });
    expect((copy.pragma('integrity_check', { simple: true }) as string).toLowerCase()).toBe('ok');
    expect((copy.prepare(`SELECT count(*) AS n FROM events`).get() as { n: number }).n).toBe(1);
    copy.close();
    await store.close();
  });

  it('rejects a database created by a future state schema', async () => {
    const { root, db } = fixture();
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const raw = new Database(db);
    raw.pragma(`user_version = ${STATE_SCHEMA_VERSION + 1}`);
    raw.close();

    const store = new SqliteStateStore({ projectRoot: root });
    await expect(store.initialize()).rejects.toThrow(/newer|future|version/i);
    await store.close();
  });

  it('migrates N to N+1 only after a verified backup and portable snapshot', async () => {
    const { root, db } = fixture();
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const raw = new Database(db);
    raw.pragma('foreign_keys = ON');
    raw.exec(STATE_MIGRATIONS[0]!.sql);
    raw.prepare(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at)
       VALUES (1, 'initial', 'fixture', '2026-07-27T12:00:00.000Z')`,
    ).run();
    raw.pragma('user_version = 1');
    raw.close();

    const store = new SqliteStateStore({
      projectRoot: root,
      now: () => new Date('2026-07-27T12:30:00.000Z'),
    });
    await store.initialize();

    expect(store.diagnostics().schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(
      fs.readdirSync(path.join(root, '.rijo', 'state', 'backups')),
    ).toContain('pre-migration-v1-20260727123000.sqlite');
    expect(fs.existsSync(path.join(root, '.rijo', 'ledger', 'latest.json'))).toBe(true);
    const inspection = new Database(db, { readonly: true });
    const index = inspection
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='index' AND name='checkpoints_kind_sequence_idx'`,
      )
      .get();
    expect(index).toBeDefined();
    inspection.close();
    await store.close();
  });

  it('projects synchronized workflow entities, decisions, commands and map versions into the ledger', async () => {
    const { root } = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent(event());
    await store.appendEvent({
      ...event('sync'),
      event_type: 'state.synchronized',
      aggregate_id: 'run-sqlite',
      payload: {
        projection: {
          milestone: { id: 'M001', slug: 'client', status: 'ACTIVE' },
          phases: [{ id: '01', status: 'IN_PROGRESS' }],
          requirements: [{ id: 'M001-REQ-001', phase: '01', status: 'PENDING' }],
          tasks: [{
            logical_task_id: 'M001:01:T01',
            phase_id: '01',
            status: 'VERIFIED',
            write_scope: ['src/a.ts'],
            tests: ['npm test'],
          }],
          attempts: [],
          map_state: {
            mapped_commit: 'abc',
            mapped_tree_hash: 'tree',
            status: 'COMPLETE',
          },
        },
      },
      idempotency_key: 'run-sqlite:sync',
    });
    await store.appendEvent({
      ...event('decision'),
      event_type: 'decision.approved',
      payload: {
        data: {
          proposal: { id: 'DEC-001', selected_option: 'SQLite' },
          attempt_id: 'attempt-1',
          generation: 1,
        },
      },
      idempotency_key: 'run-sqlite:decision',
    });
    await store.appendEvent({
      ...event('command'),
      event_type: 'run.verify_command',
      payload: { data: { command: 'npm test', exit: 0 } },
      idempotency_key: 'run-sqlite:command',
    });

    const snapshot = await store.exportSnapshot({
      generated_at: '2026-07-27T13:00:00.000Z',
      git_commit: 'abc',
      artifact_hashes: {},
    });
    expect(snapshot.milestones).toHaveLength(1);
    expect(snapshot.phases).toHaveLength(1);
    expect(snapshot.requirements).toHaveLength(1);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.decisions).toHaveLength(1);
    expect(snapshot.command_evidence).toHaveLength(1);
    expect(snapshot.map_state).toMatchObject({ mapped_commit: 'abc' });
    await store.close();
  });
});
