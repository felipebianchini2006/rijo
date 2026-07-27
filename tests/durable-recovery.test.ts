import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DurableOutboxProjector,
  MemoryStateStore,
  STATE_SCHEMA_VERSION,
  SqliteStateStore,
  buildDurableSnapshot,
  canonicalJson,
  ensureDurableGitignore,
  exportFinalizedEventSegment,
  openEngineSupervisorLedger,
  recoverSqliteState,
  writeDurableSnapshot,
  sha256,
  type DomainEvent,
} from '../src/durable/index.js';

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-recovery-'));
  roots.push(root);
  return root;
}

function created(): DomainEvent {
  return {
    event_id: 'run-create',
    run_id: 'run-recover',
    aggregate_type: 'run',
    aggregate_id: 'run-recover',
    event_type: 'run.created',
    schema_version: 1,
    payload: { plan_hash: 'plan', host: 'codex', status: 'RUNNING' },
    created_at: '2026-07-27T11:00:00.000Z',
    idempotency_key: 'run-recover:create',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('durable recovery and outbox projection', () => {
  it('replays an outbox item exactly once after rename-before-ACK crash', async () => {
    const root = fixture();
    const store = new MemoryStateStore();
    await store.initialize();
    await store.appendEvent(created());
    const crashing = new DurableOutboxProjector(root, store, {
      afterRename: () => {
        throw new Error('crash after rename');
      },
    });

    await expect(crashing.flush()).rejects.toThrow('crash after rename');
    expect(await store.readPendingOutbox()).toHaveLength(1);

    const recovered = new DurableOutboxProjector(root, store);
    expect(await recovered.flush()).toBe(1);
    expect(await store.readPendingOutbox()).toEqual([]);
    const lines = fs
      .readFileSync(path.join(root, '.rijo', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event_id":"run-create"');
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event_type: 'run.created',
      type: 'run.created',
      data: { plan_hash: 'plan', host: 'codex', status: 'RUNNING' },
    });
  });

  it('rebuilds an absent SQLite database from latest snapshot and posterior segment', async () => {
    const root = fixture();
    const source = new MemoryStateStore();
    await source.initialize();
    await source.appendEvent(created());
    const snapshot = await buildDurableSnapshot(source, {
      generated_at: '2026-07-27T11:01:00.000Z',
      git_commit: 'abc',
      artifact_hashes: {},
    });
    writeDurableSnapshot(root, snapshot);
    await source.appendEvent({
      ...created(),
      event_id: 'run-ready',
      event_type: 'run.ready',
      payload: { final_commit: 'def', terminal_reason: 'passed' },
      created_at: '2026-07-27T11:02:00.000Z',
      idempotency_key: 'run-recover:ready',
    });
    await exportFinalizedEventSegment(root, source, snapshot.last_sequence);

    const recovered = await recoverSqliteState({ projectRoot: root });

    expect(recovered.rebuilt).toBe(true);
    expect(recovered.store.diagnostics().schema_version).toBe(STATE_SCHEMA_VERSION);
    expect(await recovered.store.getRun('run-recover')).toMatchObject({
      status: 'READY',
      last_event_sequence: 2,
    });
    expect((await recovered.store.integrityCheck()).ok).toBe(true);
    await recovered.store.close();
  });

  it('rebuilds before the supervisor opens so the parent cannot replace portable state with an empty DB', async () => {
    const root = fixture();
    const source = new MemoryStateStore();
    await source.initialize();
    await source.appendEvent(created());
    const snapshot = await buildDurableSnapshot(source, {
      generated_at: '2026-07-27T11:01:00.000Z',
      git_commit: 'abc',
      artifact_hashes: {},
    });
    writeDurableSnapshot(root, snapshot);

    const supervisor = await openEngineSupervisorLedger(root, { mode: 'run' });
    expect((await supervisor.readProgress()).sequence).toBe(1);
    await supervisor.close();

    const inspect = new SqliteStateStore({ projectRoot: root });
    await inspect.initialize();
    expect(await inspect.getRun('run-recover')).toMatchObject({
      plan_hash: 'plan',
      status: 'RUNNING',
    });
    await inspect.close();
  });

  it('writes an idempotent local ignore without excluding portable ledger material', () => {
    const root = fixture();
    const first = ensureDurableGitignore(root);
    const second = ensureDurableGitignore(root);
    const content = fs.readFileSync(path.join(root, '.rijo', '.gitignore'), 'utf8');

    expect(first).toEqual(second);
    expect(content).toContain('state/rijo.db');
    expect(content).toContain('state/rijo.db-wal');
    expect(content).toContain('state/backups/');
    expect(content).toContain('runtime/');
    expect(content).not.toContain('ledger/');
  });

  it('preserves a corrupted database under a diagnostic name before rebuild', async () => {
    const root = fixture();
    const dbPath = path.join(root, '.rijo', 'state', 'rijo.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'not a sqlite database');

    await expect(recoverSqliteState({ projectRoot: root })).rejects.toThrow(/snapshot/i);

    expect(
      fs
        .readdirSync(path.dirname(dbPath))
        .some((name) => name.startsWith('rijo.db.corrupt-')),
    ).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('falls back to the newest valid portable snapshot when latest.json is corrupted', async () => {
    const root = fixture();
    const source = new MemoryStateStore();
    await source.initialize();
    await source.appendEvent(created());
    const snapshot = await buildDurableSnapshot(source, {
      generated_at: '2026-07-27T11:03:00.000Z',
      git_commit: 'abc',
      artifact_hashes: {},
    });
    writeDurableSnapshot(root, snapshot);
    fs.writeFileSync(path.join(root, '.rijo', 'ledger', 'latest.json'), '{broken');

    const recovered = await recoverSqliteState({ projectRoot: root });

    expect(recovered.rebuilt).toBe(true);
    expect(await recovered.store.getRun('run-recover')).toMatchObject({
      status: 'RUNNING',
      last_event_sequence: 1,
    });
    expect((await recovered.store.integrityCheck()).ok).toBe(true);
    await recovered.store.close();
  });

  it('repairs a canonical but adulterated latest snapshot from its immutable hash-addressed copy', async () => {
    const root = fixture();
    const source = new MemoryStateStore();
    await source.initialize();
    await source.appendEvent(created());
    const snapshot = await buildDurableSnapshot(source, {
      generated_at: '2026-07-27T11:03:00.000Z',
      git_commit: 'abc',
      artifact_hashes: {},
    });
    writeDurableSnapshot(root, snapshot);
    const adulterated = {
      ...snapshot,
      run: { ...snapshot.run!, plan_hash: 'tampered' },
    };
    fs.writeFileSync(
      path.join(root, '.rijo', 'ledger', 'latest.json'),
      `${canonicalJson(adulterated)}\n`,
    );

    const recovered = await recoverSqliteState({ projectRoot: root });
    expect(await recovered.store.getRun('run-recover')).toMatchObject({
      plan_hash: 'plan',
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(root, '.rijo', 'ledger', 'latest.json'), 'utf8'),
      ),
    ).toEqual(snapshot);
    await recovered.store.close();
  });

  it('blocks rebuild when a canonical artifact no longer matches the snapshot hash', async () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, '.rijo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rijo', 'PROJECT.md'), 'original\n');
    const source = new MemoryStateStore();
    await source.initialize();
    await source.appendEvent(created());
    const snapshot = await buildDurableSnapshot(source, {
      generated_at: '2026-07-27T11:03:00.000Z',
      git_commit: null,
      artifact_hashes: { 'PROJECT.md': sha256('original\n') },
    });
    writeDurableSnapshot(root, snapshot);
    fs.writeFileSync(path.join(root, '.rijo', 'PROJECT.md'), 'tampered\n');

    await expect(recoverSqliteState({ projectRoot: root })).rejects.toThrow(
      /artifact hash mismatch/i,
    );
  });
});
