import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileStateStore,
  openEngineSupervisorLedger,
  openDurableStateEngine,
  writeDurableSnapshot,
  type Checkpoint,
  type DomainEvent,
  type Lease,
} from '../src/durable/index.js';
import { cleanup, tmpProject } from './helpers.js';

describe('FileStateStore', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) cleanup(root);
  });

  const event: DomainEvent = {
    event_id: 'event-file-run',
    run_id: 'run-file',
    aggregate_type: 'run',
    aggregate_id: 'run-file',
    event_type: 'run.created',
    schema_version: 1,
    payload: { plan_hash: 'plan-file', host: 'codex', status: 'RUNNING' },
    created_at: '2026-07-27T12:00:00.000Z',
    idempotency_key: 'run-file:create',
  };

  const checkpoint: Checkpoint = {
    id: 'checkpoint-file',
    run_id: 'run-file',
    event_sequence: 1,
    kind: 'PHASE',
    git_commit: 'abc123',
    tree_hash: 'tree-1',
    snapshot_hash: null,
    created_at: '2026-07-27T12:01:00.000Z',
    idempotency_key: 'checkpoint-file:create',
  };

  const lease: Lease = {
    id: 'lease-file',
    run_id: 'run-file',
    logical_task_id: 'task-file',
    attempt_id: 'attempt-file',
    owner_id: 'owner-file',
    generation: 1,
    state: 'ACTIVE',
    acquired_at: '2026-07-27T12:02:00.000Z',
    heartbeat_at: '2026-07-27T12:02:00.000Z',
    expires_at: '2026-07-27T12:12:00.000Z',
    fenced_at: null,
    fence_reason: null,
    idempotency_key: 'lease-file:create',
  };

  async function populated(root: string): Promise<FileStateStore> {
    const store = new FileStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent(event);
    await store.saveCheckpoint(checkpoint);
    expect(await store.claimTask('task-file', lease)).toBe(true);
    return store;
  }

  it('persists runs, checkpoints, leases, and the hash chain across process restarts', async () => {
    const root = tmpProject('rijo-file-state-');
    roots.push(root);
    const first = await populated(root);
    await first.close();

    const second = new FileStateStore({ projectRoot: root });
    await second.initialize();

    expect(await second.getLatestRun()).toMatchObject({ id: 'run-file', plan_hash: 'plan-file' });
    const snapshot = await second.exportSnapshot({
      generated_at: '2026-07-27T12:03:00.000Z',
      git_commit: 'abc123',
      artifact_hashes: {},
    });
    expect(snapshot.checkpoints).toEqual([checkpoint]);
    expect(snapshot.leases).toEqual([lease]);
    expect((await second.integrityCheck()).ok).toBe(true);
    await second.close();
  });

  it('rebuilds from portable evidence after operational snapshot corruption', async () => {
    const root = tmpProject('rijo-file-state-corrupt-');
    roots.push(root);
    const first = await populated(root);
    const snapshot = await first.exportSnapshot({
      generated_at: '2026-07-27T12:03:00.000Z',
      git_commit: null,
      artifact_hashes: {},
    });
    writeDurableSnapshot(root, snapshot);
    await first.close();
    fs.writeFileSync(path.join(root, '.rijo', 'state', 'file-store.json'), '{corrupt');

    const recovered = new FileStateStore({ projectRoot: root });
    await recovered.initialize();

    expect(await recovered.getLatestRun()).toMatchObject({ id: 'run-file' });
    const restored = await recovered.exportSnapshot({
      generated_at: '2026-07-27T12:04:00.000Z',
      git_commit: null,
      artifact_hashes: {},
    });
    expect(restored.checkpoints).toEqual([checkpoint]);
    expect(restored.leases).toEqual([lease]);
    expect(
      fs.readdirSync(path.join(root, '.rijo', 'state')).some((name) =>
        name.startsWith('file-store.json.corrupt-'),
      ),
    ).toBe(true);
    await recovered.close();
  });

  it('reconstructs a clean clone without an operational state directory', async () => {
    const source = tmpProject('rijo-file-state-source-');
    const clone = tmpProject('rijo-file-state-clone-');
    roots.push(source, clone);
    const first = await populated(source);
    const snapshot = await first.exportSnapshot({
      generated_at: '2026-07-27T12:03:00.000Z',
      git_commit: null,
      artifact_hashes: {},
    });
    writeDurableSnapshot(source, snapshot);
    await first.close();
    fs.cpSync(path.join(source, '.rijo', 'ledger'), path.join(clone, '.rijo', 'ledger'), {
      recursive: true,
    });

    const clean = new FileStateStore({ projectRoot: clone });
    await clean.initialize();

    expect(await clean.getLatestRun()).toMatchObject({ id: 'run-file' });
    const rebuilt = await clean.exportSnapshot({
      generated_at: '2026-07-27T12:04:00.000Z',
      git_commit: null,
      artifact_hashes: {},
    });
    expect(rebuilt.checkpoints).toEqual([checkpoint]);
    expect(rebuilt.leases).toEqual([lease]);
    await clean.close();
  });

  it('opens the durable engine with the file backend when selected', async () => {
    const root = tmpProject('rijo-file-state-factory-');
    roots.push(root);

    const opened = await openDurableStateEngine({
      projectRoot: root,
      stateStore: 'file',
    });

    expect(opened.recovery.store).toBeInstanceOf(FileStateStore);
    expect((await opened.recovery.store.integrityCheck()).ok).toBe(true);
    await opened.recovery.store.close();
  });

  it('keeps engine supervision available without SQLite', async () => {
    const root = tmpProject('rijo-file-supervisor-');
    roots.push(root);
    const ledger = await openEngineSupervisorLedger(root, {
      mode: 'run',
      stateStore: 'file',
    });

    expect(await ledger.acquireSupervisorLease('owner-1', process.pid)).toBe(true);
    await ledger.appendSupervisorReceipt({
      receipt_id: 'receipt-1',
      owner_id: 'owner-1',
      type: 'engine.started',
      state: 'RUNNING',
      generation: 3,
      supervisor_pid: process.pid,
      pid: process.pid,
      process_group: null,
      created_at: '2026-07-27T12:00:00.000Z',
    });

    expect(await ledger.readLastEngineGeneration()).toBe(3);
    await ledger.releaseSupervisorLease('owner-1');
    await ledger.close();
  });
});
