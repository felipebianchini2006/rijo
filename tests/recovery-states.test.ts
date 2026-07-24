import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RijoPaths } from '../src/core/paths.js';
import { ProgressBus, silentSink } from '../src/core/progress.js';
import { defaultConfig } from '../src/core/config.js';
import { TaskRecordSchema, type SupervisedTaskState } from '../src/core/schemas/index.js';
import { reconcileSupervisedTasks } from '../src/supervisor/recover.js';
import { TaskStore } from '../src/supervisor/store.js';
import { withLock, type WorkflowContext } from '../src/workflows/shared.js';
import { tmpProject, cleanup } from './helpers.js';

// Seed a durable task record directly in a chosen state (bypassing the normal
// transition path) so recovery can be exercised for every non-terminal state.
function seed(paths: RijoPaths, state: SupervisedTaskState, over: Record<string, unknown> = {}): void {
  const store = new TaskStore(paths);
  const rec = TaskRecordSchema.parse({
    logical_task_id: 'exec-01-T01',
    attempt_id: 'exec-01-T01#g1-aaaa',
    generation: 1,
    lease_id: 'lease-1',
    idempotency_key: 'idem',
    role: 'worker',
    state,
    created_at: new Date().toISOString(),
    workspace_id: 'ws-1',
    workspace_path: '/tmp/ws-1',
    ...over,
  });
  (store as unknown as { create: (r: unknown) => unknown }).create(rec);
}

/**
 * Every NON-TERMINAL supervised state (terminal = SUCCEEDED, EXHAUSTED).
 * `resumed` is the expected final state when replacement budget remains;
 * `fenced` records whether recovery must revoke the prior attempt's lease.
 */
const NON_TERMINAL: Array<{
  from: SupervisedTaskState;
  classification: string;
  resumedState: SupervisedTaskState;
  fenced: boolean;
}> = [
  { from: 'QUEUED', classification: 'never_started', resumedState: 'EXHAUSTED', fenced: false },
  { from: 'STARTING', classification: 'no_handle', resumedState: 'REPLACING', fenced: true },
  { from: 'RUNNING', classification: 'no_handle', resumedState: 'REPLACING', fenced: true },
  { from: 'SUSPECT', classification: 'no_handle', resumedState: 'REPLACING', fenced: true },
  { from: 'CANCELLING', classification: 'no_handle', resumedState: 'REPLACING', fenced: true },
  { from: 'CANCELLED', classification: 'cancelled', resumedState: 'REPLACING', fenced: true },
  { from: 'FAILED', classification: 'failed', resumedState: 'REPLACING', fenced: true },
  { from: 'ORPHANED', classification: 'orphaned', resumedState: 'REPLACING', fenced: true },
  { from: 'REPLACING', classification: 'replacing', resumedState: 'REPLACING', fenced: true },
];

describe('recovery — table-driven per non-terminal state (budget remains)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-recover-');
  });
  afterEach(() => {
    cleanup(root);
  });

  for (const tc of NON_TERMINAL) {
    it(`${tc.from}: reconciles to ${tc.resumedState} (classification ${tc.classification}), idempotently`, async () => {
      const paths = new RijoPaths(root);
      seed(paths, tc.from);

      const report = await reconcileSupervisedTasks(paths, { maxReplacements: 2 });
      expect(report.total).toBe(1);
      const entry = report.entries[0]!;
      expect(entry.from).toBe(tc.from);
      expect(entry.classification).toBe(tc.classification);
      expect(entry.fenced).toBe(tc.fenced);
      expect(entry.action).toBe(tc.resumedState === 'EXHAUSTED' ? 'exhausted' : 'resumed');

      const store = new TaskStore(paths);
      const rec = store.read('exec-01-T01')!;
      expect(rec.state).toBe(tc.resumedState);
      if (tc.fenced) {
        expect(rec.revoked_leases).toContain('lease-1'); // prior attempt fenced
        expect(rec.workspace_id).toBeNull(); // workspace invalidated
      }

      // Idempotency: a second pass yields the same state and emits ZERO events.
      const eventsBefore = store.readEvents('exec-01-T01').length;
      const second = await reconcileSupervisedTasks(paths, { maxReplacements: 2 });
      expect(second.total).toBe(0);
      expect(store.read('exec-01-T01')!.state).toBe(tc.resumedState);
      expect(store.readEvents('exec-01-T01').length).toBe(eventsBefore);
    });
  }
});

describe('recovery — table-driven per non-terminal state (no budget)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-recover-');
  });
  afterEach(() => {
    cleanup(root);
  });

  for (const tc of NON_TERMINAL) {
    it(`${tc.from}: reconciles to a terminal EXHAUSTED when no replacement budget remains`, async () => {
      const paths = new RijoPaths(root);
      seed(paths, tc.from);

      const report = await reconcileSupervisedTasks(paths, { maxReplacements: 0 });
      expect(report.total).toBe(1);
      expect(report.entries[0]!.action).toBe('exhausted');

      const store = new TaskStore(paths);
      expect(store.read('exec-01-T01')!.state).toBe('EXHAUSTED'); // terminal
      if (tc.fenced) expect(store.read('exec-01-T01')!.revoked_leases).toContain('lease-1');

      // A second pass is a no-op: EXHAUSTED is terminal, never re-listed.
      const eventsBefore = store.readEvents('exec-01-T01').length;
      const second = await reconcileSupervisedTasks(paths, { maxReplacements: 0 });
      expect(second.total).toBe(0);
      expect(store.readEvents('exec-01-T01').length).toBe(eventsBefore);
    });
  }
});

describe('recovery — budget honors replacement_count already spent', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-recover-');
  });
  afterEach(() => {
    cleanup(root);
  });

  it('a RUNNING record that already spent its replacements is exhausted, not resumed', async () => {
    const paths = new RijoPaths(root);
    seed(paths, 'RUNNING', { replacement_count: 2 });
    const report = await reconcileSupervisedTasks(paths, { maxReplacements: 2 });
    expect(report.entries[0]!.action).toBe('exhausted');
    expect(new TaskStore(paths).read('exec-01-T01')!.state).toBe('EXHAUSTED');
  });
});

describe('recovery — orphan workspace discard runs through withLock', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-recover-');
  });
  afterEach(() => {
    cleanup(root);
  });

  function makeCtx(): WorkflowContext {
    const paths = new RijoPaths(root);
    const now = () => new Date();
    const bus = new ProgressBus(paths, 'test-run', silentSink, now);
    return { paths, bus, now, config: defaultConfig() } as unknown as WorkflowContext;
  }

  it('discards leftover attempt workspaces and reconciles a crashed task before the body runs', async () => {
    const paths = new RijoPaths(root);
    // A crashed run left an orphan workspace copy and an in-flight RUNNING record.
    const wsDir = path.join(paths.runtimeDir, 'workspaces');
    fs.mkdirSync(path.join(wsDir, 'ws-exec-01-T01-abc', 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'ws-exec-01-T01-abc', 'src', 'a.ts'), '// stale attempt edit\n');
    seed(paths, 'RUNNING');

    const emitted: Array<{ type: string; data: unknown }> = [];
    const ctx = makeCtx();
    const originalEmit = ctx.bus.emit.bind(ctx.bus);
    ctx.bus.emit = ((type: string, update?: unknown, data?: unknown) => {
      emitted.push({ type, data });
      return originalEmit(type, update as never, data as never);
    }) as typeof ctx.bus.emit;

    let workspacesAtBodyTime: string[] = ['<not-run>'];
    await withLock(ctx, async () => {
      // The body must observe a clean slate: no orphan workspaces remain.
      workspacesAtBodyTime = fs.existsSync(wsDir) ? fs.readdirSync(wsDir) : [];
      return null;
    });

    // Orphan workspace gone before the body ran.
    expect(workspacesAtBodyTime).toEqual([]);
    expect(emitted.some((e) => e.type === 'workspace.orphan_discarded')).toBe(true);

    // The crashed supervised task was reconciled (fenced + resumed with budget).
    const rec = new TaskStore(paths).read('exec-01-T01')!;
    expect(rec.state).toBe('REPLACING');
    expect(rec.revoked_leases).toContain('lease-1');
    expect(rec.workspace_id).toBeNull();
    expect(emitted.some((e) => e.type === 'supervised.recovered')).toBe(true);
  });
});
