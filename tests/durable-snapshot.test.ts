import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryStateStore,
  buildDurableSnapshot,
  collectCanonicalArtifactHashes,
  readLatestSnapshot,
  writeDurableSnapshot,
  type DomainEvent,
} from '../src/durable/index.js';

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-snapshot-'));
  roots.push(root);
  return root;
}

function created(): DomainEvent {
  return {
    event_id: 'create',
    run_id: 'run-rebuild',
    aggregate_type: 'run',
    aggregate_id: 'run-rebuild',
    event_type: 'run.created',
    schema_version: 1,
    payload: { plan_hash: 'p1', host: 'claude', status: 'RUNNING' },
    created_at: '2026-07-27T10:00:00.000Z',
    idempotency_key: 'run-rebuild:create',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('durable snapshots and rebuild', () => {
  it('does not classify the advancing events.jsonl projection as immutable', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, '.rijo'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rijo', 'PROJECT.md'), 'project\n');
    fs.writeFileSync(path.join(root, '.rijo', 'events.jsonl'), '{"sequence":1}\n');

    const hashes = collectCanonicalArtifactHashes(root);

    expect(hashes['PROJECT.md']).toBeTruthy();
    expect(hashes['events.jsonl']).toBeUndefined();
  });

  it('writes deterministic portable snapshots and an atomic latest manifest', async () => {
    const root = fixture();
    const store = new MemoryStateStore();
    await store.initialize();
    await store.appendEvent(created());
    const snapshot = await buildDurableSnapshot(store, {
      generated_at: '2026-07-27T10:01:00.000Z',
      git_commit: 'abc123',
      artifact_hashes: { 'PROJECT.md': 'deadbeef' },
    });

    const first = writeDurableSnapshot(root, snapshot);
    const second = writeDurableSnapshot(root, snapshot);

    expect(first.path).toBe(second.path);
    expect(first.hash).toBe(second.hash);
    expect(path.basename(first.path)).toMatch(/^1-[a-f0-9]{64}\.json$/);
    expect(readLatestSnapshot(root)).toEqual(snapshot);
  });

  it('rebuilds a missing store from a snapshot plus later events exactly once', async () => {
    const source = new MemoryStateStore();
    await source.initialize();
    await source.appendEvent(created());
    const snapshot = await buildDurableSnapshot(source, {
      generated_at: '2026-07-27T10:01:00.000Z',
      git_commit: 'abc123',
      artifact_hashes: {},
    });
    const later: DomainEvent = {
      ...created(),
      event_id: 'ready',
      event_type: 'run.ready',
      payload: { final_commit: 'def456', terminal_reason: 'all gates passed' },
      idempotency_key: 'run-rebuild:ready',
      created_at: '2026-07-27T10:02:00.000Z',
    };

    const rebuilt = new MemoryStateStore();
    await rebuilt.initialize();
    await rebuilt.rebuild(snapshot, [later, later]);

    expect(await rebuilt.getRun('run-rebuild')).toMatchObject({
      status: 'READY',
      final_commit: 'def456',
      last_event_sequence: 2,
    });
    // The snapshot is the compacted baseline at sequence 1; only posterior
    // event segments are replayed into the rebuilt ledger.
    expect(await rebuilt.readEvents()).toHaveLength(1);
    expect((await rebuilt.integrityCheck()).ok).toBe(true);
  });
});
