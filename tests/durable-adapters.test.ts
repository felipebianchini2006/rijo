import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteStateStore,
  openDurableWorkflowEngine,
  openEngineSupervisorLedger,
} from '../src/durable/index.js';

const roots: string[] = [];

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-adapter-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('durable production adapters', () => {
  it('keeps durable attempt generations monotonic across engine redispatches', async () => {
    const root = fixture();
    const store = new SqliteStateStore({ projectRoot: root });
    await store.initialize();
    await store.appendEvent({
      event_id: 'create-generation-run',
      run_id: 'generation-run',
      aggregate_type: 'run',
      aggregate_id: 'generation-run',
      event_type: 'run.created',
      schema_version: 1,
      payload: { plan_hash: 'hash', host: 'codex', status: 'RUNNING' },
      created_at: '2026-07-27T09:00:00.000Z',
      idempotency_key: 'generation-run:create',
    });
    const projection = (attemptId: string) => ({
      milestone: { id: 'M001', status: 'ACTIVE' },
      phases: [{ id: 'F01', status: 'IN_PROGRESS' }],
      requirements: [],
      tasks: [],
      attempts: [{
        logical_task_id: 'M001:F01:T01',
        attempt_id: attemptId,
        generation: 1,
        lease_id: `lease-${attemptId}`,
        state: 'ACTIVE',
      }],
      map_state: null,
    });
    for (const [index, attemptId] of ['attempt-a', 'attempt-b'].entries()) {
      await store.appendEvent({
        event_id: `sync-${attemptId}`,
        run_id: 'generation-run',
        aggregate_type: 'run',
        aggregate_id: 'generation-run',
        event_type: 'state.synchronized',
        schema_version: 1,
        payload: { projection: projection(attemptId) },
        created_at: `2026-07-27T09:0${index + 1}:00.000Z`,
        idempotency_key: `generation-run:sync:${attemptId}`,
      });
    }
    const snapshot = await store.exportSnapshot({
      generated_at: '2026-07-27T09:03:00.000Z',
      git_commit: null,
      artifact_hashes: {},
    });

    expect(snapshot.attempts.map((attempt) => attempt['generation'])).toEqual([1, 2]);
    await store.close();
  });

  it('returns plan_mismatch for --next while a run is active without appending run.resumed', async () => {
    const root = fixture();
    const engine = await openDurableWorkflowEngine(root);
    await engine.initialize();
    await engine.recover();
    const created = await engine.beginOrResumeRun({
      requestedRunId: 'requested-1',
      plan: '# Plan\n',
      host: 'codex',
    });
    expect(created.disposition).toBe('created');

    const refused = await engine.beginOrResumeRun({
      requestedRunId: 'requested-2',
      plan: '# Plan\n',
      host: 'codex',
      next: true,
    });
    expect(refused.disposition).toBe('plan_mismatch');
    await engine.close();

    const inspect = new SqliteStateStore({ projectRoot: root });
    await inspect.initialize();
    expect((await inspect.readEvents()).map((event) => event.event_type)).toEqual(['run.created']);
    await inspect.close();
  });

  it('does not create a duplicate run when new is repeated without --next after a terminal run', async () => {
    const root = fixture();
    const first = await openDurableWorkflowEngine(root);
    await first.beginOrResumeRun({
      requestedRunId: 'run-terminal',
      plan: '# Same plan\n',
      host: 'codex',
    });
    await first.markTerminal({
      status: 'READY',
      reason: 'done',
      commit: 'abc',
    });
    await first.createSnapshot({ reason: 'terminal:READY' });
    await first.close();

    const repeated = await openDurableWorkflowEngine(root);
    const binding = await repeated.beginOrResumeRun({
      requestedRunId: 'must-not-exist',
      plan: '# Same plan\n',
      host: 'codex',
    });
    expect(binding.disposition).toBe('plan_mismatch');
    await repeated.close();

    const inspect = new SqliteStateStore({ projectRoot: root });
    await inspect.initialize();
    expect((await inspect.readEvents()).filter((event) => event.event_type === 'run.created')).toHaveLength(1);
    await inspect.close();
  });

  it('resumes the same BLOCKED run without creating a duplicate', async () => {
    const root = fixture();
    const first = await openDurableWorkflowEngine(root);
    await first.beginOrResumeRun({
      requestedRunId: 'blocked-run',
      plan: '# Blocked plan\n',
      host: 'codex',
    });
    await first.markTerminal({
      status: 'BLOCKED',
      reason: 'credential unavailable',
    });
    await first.createSnapshot({ reason: 'terminal:BLOCKED' });
    await first.close();

    const supervisor = await openEngineSupervisorLedger(root, { mode: 'run' });
    expect(await supervisor.readRunStatus()).toBeNull();
    await supervisor.close();

    const resumed = await openDurableWorkflowEngine(root);
    const binding = await resumed.beginOrResumeRun({
      requestedRunId: 'must-not-exist',
      plan: '# Blocked plan\n',
      host: 'codex',
    });
    expect(binding).toMatchObject({
      runId: 'blocked-run',
      disposition: 'resumed',
    });
    await resumed.close();

    const inspect = new SqliteStateStore({ projectRoot: root });
    await inspect.initialize();
    expect((await inspect.readEvents()).filter((event) => event.event_type === 'run.created')).toHaveLength(1);
    expect(await inspect.getRun('blocked-run')).toMatchObject({ status: 'RUNNING' });
    await inspect.close();
  });

  it('commits checkpoint event and row atomically and retries them exactly once', async () => {
    const root = fixture();
    const engine = await openDurableWorkflowEngine(root, {
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });
    await engine.beginOrResumeRun({
      requestedRunId: 'checkpoint-run',
      plan: '# Checkpoint\n',
      host: 'codex',
    });
    await engine.createCheckpoint({ reason: 'task:01:T01:verified', commit: 'abc123' });
    await engine.createCheckpoint({ reason: 'task:01:T01:verified', commit: 'abc123' });
    await engine.close();

    const inspect = new SqliteStateStore({ projectRoot: root });
    await inspect.initialize();
    const snapshot = await inspect.exportSnapshot({
      generated_at: '2026-07-27T12:01:00.000Z',
      git_commit: 'abc123',
      artifact_hashes: {},
    });
    expect(snapshot.checkpoints).toHaveLength(1);
    expect(
      (await inspect.readEvents()).filter((event) => event.event_type === 'checkpoint.created'),
    ).toHaveLength(1);
    await inspect.close();
  });

  it('opens a supervisor ledger beside the engine writer without taking its writer lock', async () => {
    const root = fixture();
    const engineStore = new SqliteStateStore({ projectRoot: root });
    await engineStore.initialize();
    await engineStore.appendEvent({
      event_id: 'create',
      run_id: 'run-1',
      aggregate_type: 'run',
      aggregate_id: 'run-1',
      event_type: 'run.created',
      schema_version: 1,
      payload: { plan_hash: 'hash', host: 'claude', status: 'RUNNING' },
      created_at: '2026-07-27T12:00:00.000Z',
      idempotency_key: 'run-1:create',
    });

    const supervisor = await openEngineSupervisorLedger(root);
    expect(await supervisor.acquireSupervisorLease('owner', process.pid)).toBe(true);
    await supervisor.appendSupervisorReceipt({
      receipt_id: 'receipt-1',
      owner_id: 'owner',
      type: 'engine.started',
      state: 'RUNNING',
      generation: 3,
      supervisor_pid: process.pid,
      pid: null,
      process_group: null,
      created_at: '2026-07-27T12:01:00.000Z',
    });
    expect(await supervisor.readLastEngineGeneration()).toBe(3);
    expect((await supervisor.readProgress()).sequence).toBe(1);
    await supervisor.appendSupervisorReceipt({
      receipt_id: 'heartbeat-1',
      owner_id: 'owner',
      type: 'engine.heartbeat',
      state: 'RUNNING',
      generation: 3,
      supervisor_pid: process.pid,
      pid: null,
      process_group: null,
      created_at: '2026-07-27T12:01:01.000Z',
    });
    expect((await supervisor.readProgress()).sequence).toBe(2);
    await supervisor.releaseSupervisorLease('owner');
    await supervisor.close();
    await engineStore.close();
  });

  it('new-mode supervisor ignores a terminal run that predates its opening', async () => {
    const root = fixture();
    const writer = new SqliteStateStore({ projectRoot: root });
    await writer.initialize();
    await writer.appendEvent({
      event_id: 'create-old',
      run_id: 'run-old',
      aggregate_type: 'run',
      aggregate_id: 'run-old',
      event_type: 'run.created',
      schema_version: 1,
      payload: { plan_hash: 'old', host: 'codex', status: 'RUNNING' },
      created_at: '2026-07-27T10:00:00.000Z',
      idempotency_key: 'run-old:create',
    });
    await writer.appendEvent({
      event_id: 'ready-old',
      run_id: 'run-old',
      aggregate_type: 'run',
      aggregate_id: 'run-old',
      event_type: 'run.ready',
      schema_version: 1,
      payload: { final_commit: 'abc', terminal_reason: 'done' },
      created_at: '2026-07-27T10:01:00.000Z',
      idempotency_key: 'run-old:ready',
    });

    const newMode = await openEngineSupervisorLedger(root, { mode: 'new' });
    const runMode = await openEngineSupervisorLedger(root, { mode: 'run' });
    expect(await newMode.readRunStatus()).toBeNull();
    expect(await runMode.readRunStatus()).toBe('READY');
    await newMode.close();
    await runMode.close();
    await writer.close();
  });

  it('never treats a newer null-PID fencing receipt as proof that an older engine tree died', async () => {
    const root = fixture();
    const writer = new SqliteStateStore({ projectRoot: root });
    await writer.initialize();
    await writer.appendEvent({
      event_id: 'create-live',
      run_id: 'run-live',
      aggregate_type: 'run',
      aggregate_id: 'run-live',
      event_type: 'run.created',
      schema_version: 1,
      payload: { plan_hash: 'live', host: 'codex', status: 'RUNNING' },
      created_at: '2026-07-27T10:00:00.000Z',
      idempotency_key: 'run-live:create',
    });
    const supervisor = await openEngineSupervisorLedger(root);
    await supervisor.appendSupervisorReceipt({
      receipt_id: 'engine-started-live',
      owner_id: 'owner',
      type: 'engine.started',
      state: 'RUNNING',
      generation: 7,
      supervisor_pid: process.pid,
      pid: process.pid,
      process_group: null,
      created_at: '2026-07-27T10:01:00.000Z',
    });
    await supervisor.appendSupervisorReceipt({
      receipt_id: 'engine-fenced-without-identity',
      owner_id: 'owner',
      type: 'engine.fenced',
      state: 'TERMINATING',
      generation: 7,
      supervisor_pid: process.pid,
      pid: null,
      process_group: null,
      created_at: '2026-07-27T10:02:00.000Z',
    });

    expect(await supervisor.reconcileEngineGeneration(7)).toMatchObject({
      engine_tree_gone: false,
    });
    await supervisor.close();
    await writer.close();
  });
});
