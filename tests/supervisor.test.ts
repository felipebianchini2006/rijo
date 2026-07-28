import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RijoPaths } from '../src/core/paths.js';
import { AgentTaskSchema, type AgentTask, type AgentResult } from '../src/agents/protocol.js';
import { SupervisorConfigSchema, type SupervisorConfig } from '../src/core/schemas/index.js';
import type {
  HostAgentController,
  HostAttemptHandle,
  HostLiveness,
  CancelReceipt,
  TerminationReceipt,
  HostAttemptStatus,
  SupervisedAgentTask,
} from '../src/hosts/controller.js';
import {
  Supervisor,
  FakeClock,
  InProcessController,
  reconcileSupervisedTasks,
  type SuperviseOptions,
  type PreparedAttempt,
} from '../src/supervisor/index.js';
import { FakeAgentRunner } from '../src/agents/runner.js';
import type { ReplayAttemptIdentity } from '../src/agents/runner.js';
import { TaskRecordSchema } from '../src/core/schemas/index.js';
import { TaskStore } from '../src/supervisor/store.js';
import { sha256 } from '../src/core/fsx.js';

// ---- unhandled-rejection guard ------------------------------------------------
const unhandled: unknown[] = [];
beforeAll(() => {
  process.on('unhandledRejection', (r) => unhandled.push(r));
});
afterEach(() => {
  expect(unhandled).toEqual([]);
});

// ---- helpers ------------------------------------------------------------------
function tmpPaths(): RijoPaths {
  return new RijoPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-sup-')));
}

function makeTask(id = 'exec-01-T01', over: Partial<AgentTask> = {}): AgentTask {
  return AgentTaskSchema.parse({
    id,
    role: 'worker',
    objective: 'do the thing',
    return_format: 'JSON',
    workspace: { id: `ws-${id}-g1`, root: `/tmp/${id}-g1` },
    ...over,
  });
}

function cfg(over: Partial<Record<string, unknown>> = {}): SupervisorConfig {
  return SupervisorConfigSchema.parse({
    heartbeat_interval_ms: 1_000,
    heartbeat_grace_ms: 3_000,
    cancel_grace_ms: 2_000,
    hard_kill_grace_ms: 1_000,
    max_replacements_per_task: 0,
    max_total_task_elapsed_ms: 600_000,
    replacement_backoff_ms: [500, 500],
    ...over,
  });
}

/**
 * Fully scriptable host controller. Every liveness/cancel/query answer is set
 * by the test; results are delivered explicitly (or auto-failed) so late,
 * duplicate and stale-lease deliveries can be reproduced deterministically.
 */
class FakeController implements HostAgentController {
  readonly host = 'fake';
  started: AgentTask[] = [];
  liveness: HostLiveness = { alive: true };
  livenessThrows = false;
  cancelBehavior: 'ack' | 'noack' | 'never' = 'ack';
  queryStatus: HostAttemptStatus = { kind: 'running' };
  replayIdentity: ReplayAttemptIdentity | null = null;
  disposedAttempts: string[] = [];
  autoFail = false;
  forceTerminate?: (handle: HostAttemptHandle, reason: string) => Promise<TerminationReceipt>;
  private forceBehavior: 'terminate' | 'fail' | 'never';
  private readonly deferreds = new Map<string, { resolve: (r: AgentResult) => void; task: AgentTask }>();

  constructor(opts: { forceTerminate?: boolean; forceBehavior?: 'terminate' | 'fail' | 'never' } = {}) {
    this.forceBehavior = opts.forceBehavior ?? 'terminate';
    if (opts.forceTerminate) this.forceTerminate = () => this.doForce();
  }

  replayAttempt(): ReplayAttemptIdentity | null {
    return this.replayIdentity;
  }

  private doForce(): Promise<TerminationReceipt> {
    if (this.forceBehavior === 'terminate') return Promise.resolve({ terminated: true, method: 'sigkill' });
    if (this.forceBehavior === 'fail') return Promise.resolve({ terminated: false, method: 'sigkill' });
    return new Promise<TerminationReceipt>(() => {});
  }

  async start(sup: SupervisedAgentTask): Promise<HostAttemptHandle> {
    const task = sup.task;
    this.started.push(task);
    const attempt = task.attempt!;
    const result = new Promise<AgentResult>((resolve) => {
      this.deferreds.set(attempt.attempt_id, { resolve, task });
    });
    if (this.autoFail) {
      queueMicrotask(() => this.deliver(attempt.attempt_id, this.matching(attempt.attempt_id, { ok: false, summary: 'auto-fail' })));
    }
    return { attempt_id: attempt.attempt_id, lease_id: attempt.lease_id, generation: attempt.generation, host: this.host, result };
  }

  async heartbeat(): Promise<HostLiveness> {
    if (this.livenessThrows) throw new Error('heartbeat unreachable');
    return this.liveness;
  }

  async requestCancel(): Promise<CancelReceipt> {
    if (this.cancelBehavior === 'ack') return { requested: true, acknowledged: true };
    if (this.cancelBehavior === 'noack') return { requested: true, acknowledged: false };
    return new Promise<CancelReceipt>(() => {});
  }

  async query(): Promise<HostAttemptStatus> {
    return this.queryStatus;
  }

  async dispose(handle: HostAttemptHandle): Promise<void> {
    this.disposedAttempts.push(handle.attempt_id);
  }

  // ---- test drivers ----
  deliver(attemptId: string, result: AgentResult): void {
    this.deferreds.get(attemptId)?.resolve(result);
  }
  lastAttemptId(): string {
    return this.started[this.started.length - 1]!.attempt!.attempt_id;
  }
  matching(attemptId: string, over: Partial<AgentResult> = {}): AgentResult {
    const task = this.deferreds.get(attemptId)!.task;
    const a = task.attempt!;
    return {
      task_id: task.id,
      ok: true,
      summary: 'done',
      files_written: [],
      payload: null,
      scope_requests: [],
      attempt_id: a.attempt_id,
      generation: a.generation,
      lease_id: a.lease_id,
      ...over,
    };
  }
}

function newSupervisor(controller: HostAgentController, config: SupervisorConfig, paths = tmpPaths()) {
  const clock = new FakeClock();
  const supervisor = new Supervisor({ controller, config, paths, clock });
  return { clock, supervisor, paths };
}

// ---- tests --------------------------------------------------------------------

describe('supervisor — liveness and deadlines', () => {
  it('cancels and blocks when the host never responds (heartbeat never alive)', async () => {
    const c = new FakeController();
    c.liveness = { alive: false, detail: 'silent' };
    const { clock, supervisor, paths } = newSupervisor(c, cfg());
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    await clock.advance(20_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('BLOCKED');
    const events = new TaskStore(paths).readEvents('exec-01-T01').map((e) => e.type);
    expect(events).toContain('state_transition');
    const rec = new TaskStore(paths).read('exec-01-T01');
    expect(rec?.state).toBe('EXHAUSTED');
    expect(clock.pendingTimers).toBe(0);
  });

  it('cancels when a previously-live heartbeat stops', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    const { clock, supervisor, paths } = newSupervisor(c, cfg());
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    await clock.advance(5_000); // healthy for a while
    c.liveness = { alive: false, detail: 'stopped' };
    await clock.advance(10_000);
    const r = await p;
    expect(r.ok).toBe(false);
    const store = new TaskStore(paths);
    const cancelling = store.readEvents('exec-01-T01').find((e) => e.data['to'] === 'CANCELLING');
    expect(cancelling?.data['reason']).toContain('heartbeat lost');
    expect(clock.pendingTimers).toBe(0);
  });

  it('cancels on hard deadline even while heartbeat stays alive', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ hard_timeout_ms: { worker: 8_000 } }));
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    await clock.advance(9_000);
    const r = await p;
    expect(r.ok).toBe(false);
    const cancel = new TaskStore(paths).readEvents('exec-01-T01').find((e) => e.data['to'] === 'CANCELLING');
    expect(cancel?.data['reason']).toContain('hard timeout');
    expect(clock.pendingTimers).toBe(0);
  });

  it('cancels on no-progress timeout while heartbeat stays alive', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ no_progress_timeout_ms: { worker: 4_000 } }));
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    await clock.advance(9_000);
    const r = await p;
    expect(r.ok).toBe(false);
    const cancel = new TaskStore(paths).readEvents('exec-01-T01').find((e) => e.data['to'] === 'CANCELLING');
    expect(cancel?.data['reason']).toContain('no progress');
    expect(clock.pendingTimers).toBe(0);
  });

  it('does NOT replace a slow attempt that keeps a valid heartbeat and progress', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    const { clock, supervisor } = newSupervisor(c, cfg({ max_replacements_per_task: 2 }));
    const opts: SuperviseOptions = {};
    const p = supervisor.superviseTask(makeTask(), opts);
    await clock.advance(0);
    // stays alive and makes progress for a long time
    for (let i = 0; i < 10; i++) {
      supervisor.notifyProgress('exec-01-T01');
      await clock.advance(2_000);
    }
    // finally completes
    c.deliver(c.lastAttemptId(), c.matching(c.lastAttemptId()));
    await clock.advance(0);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(c.started.length).toBe(1); // never replaced
    expect(c.started[0]!.attempt!.generation).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('supervisor — cancellation ladder', () => {
  it('cancels cleanly when the host acknowledges (no fencing, no force)', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    c.cancelBehavior = 'ack';
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ hard_timeout_ms: { worker: 5_000 } }));
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    await clock.advance(6_000);
    await p;
    const events = new TaskStore(paths).readEvents('exec-01-T01').map((e) => e.type);
    expect(events).not.toContain('fenced');
    expect(events).not.toContain('force_terminated');
    const rec = new TaskStore(paths).read('exec-01-T01');
    expect(rec?.cancel_acknowledged_at).not.toBeNull();
    expect(clock.pendingTimers).toBe(0);
  });

  it('escalates to forceTerminate when cancel is never acknowledged', async () => {
    const c = new FakeController({ forceTerminate: true, forceBehavior: 'terminate' });
    c.liveness = { alive: true };
    c.cancelBehavior = 'never';
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ hard_timeout_ms: { worker: 5_000 } }));
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    await clock.advance(10_000);
    await p;
    const events = new TaskStore(paths).readEvents('exec-01-T01').map((e) => e.type);
    expect(events).toContain('force_terminated');
    expect(events).not.toContain('fenced');
    expect(clock.pendingTimers).toBe(0);
  });

  it('fences (revokes lease + invalidates workspace) when there is no forceTerminate', async () => {
    const c = new FakeController({ forceTerminate: false });
    c.liveness = { alive: true };
    c.cancelBehavior = 'noack';
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ hard_timeout_ms: { worker: 5_000 } }));
    const task = makeTask();
    const p = supervisor.superviseTask(task);
    await clock.advance(0);
    const gen1 = c.lastAttemptId();
    await clock.advance(10_000);
    const r = await p;
    expect(r.ok).toBe(false); // BLOCKED, not the agent's result

    const store = new TaskStore(paths);
    const rec = store.read('exec-01-T01')!;
    expect(rec.revoked_leases.length).toBeGreaterThan(0);
    expect(rec.workspace_id).toBeNull(); // workspace invalidated
    const fenced = store.readEvents('exec-01-T01').find((e) => e.type === 'fenced');
    expect(fenced?.data['termination']).toBe('not_supported');

    // A late result carrying the revoked lease is discarded.
    c.deliver(gen1, c.matching(gen1));
    await clock.advance(0);
    const stale = store.readEvents('exec-01-T01').filter((e) => e.type === 'late_or_stale_result');
    expect(stale.length).toBeGreaterThan(0);
    expect(stale[0]!.data['disposition']).toBe('LATE_OR_STALE_RESULT');
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('supervisor — result acceptance and staleness', () => {
  it('discards a result that arrives after cancellation (LATE_OR_STALE_RESULT)', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    c.cancelBehavior = 'ack';
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ hard_timeout_ms: { worker: 4_000 } }));
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    const gen1 = c.lastAttemptId();
    await clock.advance(5_000); // hard deadline → cancelled → exhausted
    const r = await p;
    expect(r.ok).toBe(false);
    // Now the agent finally answers — must be discarded.
    c.deliver(gen1, c.matching(gen1));
    await clock.advance(0);
    const stale = new TaskStore(paths).readEvents('exec-01-T01').filter((e) => e.type === 'late_or_stale_result');
    expect(stale.length).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('accepts the first result and treats a duplicate as idempotent (discarded)', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    const { clock, supervisor, paths } = newSupervisor(c, cfg());
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    const gen1 = c.lastAttemptId();
    const result = c.matching(gen1);
    c.deliver(gen1, result);
    await clock.advance(0);
    const r = await p;
    expect(r.ok).toBe(true);
    // duplicate delivery via out-of-band ingestion
    const disposition = supervisor.ingestResult('exec-01-T01', result);
    expect(disposition).toBe('discarded');
    const store = new TaskStore(paths);
    expect(store.read('exec-01-T01')!.state).toBe('SUCCEEDED');
    expect(store.readEvents('exec-01-T01').filter((e) => e.type === 'late_or_stale_result').length).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('ignores a result carrying an old lease/generation after replacement', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    let gen = 0;
    const prepareAttempt = (generation: number): PreparedAttempt => {
      gen = generation;
      return { task: makeTask('exec-01-T01', { workspace: { id: `ws-g${generation}`, root: `/tmp/g${generation}` } }), dispose() {} };
    };
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ max_replacements_per_task: 2 }));
    const p = supervisor.superviseTask(makeTask(), { prepareAttempt });
    await clock.advance(0);
    const gen1 = c.lastAttemptId();
    // gen1 fails → replacement to gen2
    c.deliver(gen1, c.matching(gen1, { ok: false, summary: 'gen1 failed' }));
    await clock.advance(0); // settle FAILED → REPLACING → schedule backoff timer
    await clock.advance(1_000); // fire backoff → start gen2
    expect(c.started.length).toBe(2);
    const gen2 = c.lastAttemptId();
    expect(gen).toBe(2);
    // A stale gen1 result (old lease/generation) now shows up out of band — must be ignored.
    const g1 = c.started[0]!.attempt!;
    const disposition = supervisor.ingestResult('exec-01-T01', {
      task_id: 'exec-01-T01',
      ok: true,
      summary: 'stale gen1',
      files_written: [],
      payload: null,
      scope_requests: [],
      attempt_id: g1.attempt_id,
      generation: g1.generation,
      lease_id: g1.lease_id,
    });
    expect(disposition).toBe('discarded');
    void gen1;
    const stale = new TaskStore(paths).readEvents('exec-01-T01').filter((e) => e.type === 'late_or_stale_result');
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.some((e) => e.data['result_lease_id'] === g1.lease_id)).toBe(true);
    // gen2 succeeds and is accepted.
    c.deliver(gen2, c.matching(gen2));
    await clock.advance(0);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.generation).toBe(2);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('supervisor — replacement and exhaustion', () => {
  it('gives each replacement a fresh identity and a fresh prepareAttempt task with a failure note', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    const seen: Array<{ generation: number; previousFailure: string }> = [];
    const prepareAttempt = (generation: number, previousFailure: string): PreparedAttempt => {
      seen.push({ generation, previousFailure });
      return { task: makeTask('exec-01-T01', { workspace: { id: `ws-g${generation}`, root: `/tmp/g${generation}` } }), dispose() {} };
    };
    const { clock, supervisor } = newSupervisor(c, cfg({ max_replacements_per_task: 2 }));
    const p = supervisor.superviseTask(makeTask(), { prepareAttempt });
    await clock.advance(0);
    const gen1 = c.lastAttemptId();
    c.deliver(gen1, c.matching(gen1, { ok: false, summary: 'boom' }));
    await clock.advance(0); // settle FAILED → REPLACING → schedule backoff timer
    await clock.advance(1_000); // fire backoff → start gen2
    const gen2Task = c.started[1]!;
    expect(gen2Task.attempt!.generation).toBe(2);
    expect(gen2Task.workspace!.id).toBe('ws-g2');
    expect(gen2Task.attempt!.attempt_id).not.toBe(gen1);
    expect(gen2Task.attempt!.lease_id).not.toBe(c.started[0]!.attempt!.lease_id);
    expect(gen2Task.notes).toContain('[supervisor] previous attempt 1 failed');
    expect(seen[0]).toEqual({ generation: 2, previousFailure: 'agent reported failure: boom' });
    // complete gen2
    c.deliver(c.lastAttemptId(), c.matching(c.lastAttemptId()));
    await clock.advance(0);
    await p;
    expect(clock.pendingTimers).toBe(0);
  });

  it('exhausts after the maximum replacements and returns an actionable BLOCKED result', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    c.autoFail = true;
    const prepareAttempt = (generation: number): PreparedAttempt => ({
      task: makeTask('exec-01-T01', { workspace: { id: `ws-g${generation}`, root: `/tmp/g${generation}` } }),
      dispose() {},
    });
    const { clock, supervisor, paths } = newSupervisor(c, cfg({ max_replacements_per_task: 2 }));
    const p = supervisor.superviseTask(makeTask(), { prepareAttempt });
    await clock.advance(0);
    await clock.advance(5_000); // covers both backoffs + auto-fails
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('BLOCKED');
    expect(r.summary).toContain('exhausted after 2 replacement');
    const diag = (r.payload as { diagnostic: { attempts: number; final_state: string } }).diagnostic;
    expect(diag.attempts).toBe(3);
    expect(diag.final_state).toBe('EXHAUSTED');
    expect(c.started.length).toBe(3);
    expect(new TaskStore(paths).read('exec-01-T01')!.state).toBe('EXHAUSTED');
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('supervisor — dispose and isolation', () => {
  it('dispose cancels the active attempt and leaves no orphan timers', async () => {
    const c = new FakeController();
    c.liveness = { alive: true };
    c.cancelBehavior = 'ack';
    const { clock, supervisor } = newSupervisor(c, cfg());
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    await supervisor.dispose();
    await clock.advance(0);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('CANCELLED');
    expect(clock.pendingTimers).toBe(0);
  });

  it('one stuck task does not prevent an independent task from completing', async () => {
    const paths = tmpPaths();
    const clock = new FakeClock();
    const stuck = new FakeController();
    stuck.liveness = { alive: false }; // never proves liveness
    const healthy = new FakeController();
    healthy.liveness = { alive: true };
    const supStuck = new Supervisor({ controller: stuck, config: cfg({ hard_timeout_ms: { worker: 4_000 } }), paths, clock });
    const supHealthy = new Supervisor({ controller: healthy, config: cfg(), paths, clock });

    const pStuck = supStuck.superviseTask(makeTask('stuck-T01'));
    const pHealthy = supHealthy.superviseTask(makeTask('healthy-T01'));
    await clock.advance(0);
    // healthy completes immediately
    healthy.deliver(healthy.lastAttemptId(), healthy.matching(healthy.lastAttemptId()));
    await clock.advance(0);
    const rHealthy = await pHealthy;
    expect(rHealthy.ok).toBe(true);
    // stuck one is still being wound down; drive it to exhaustion
    await clock.advance(10_000);
    const rStuck = await pStuck;
    expect(rStuck.ok).toBe(false);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('supervisor — in-process runner controller', () => {
  it('supervises a FakeAgentRunner attempt to success (identity stamped)', async () => {
    const runner = new FakeAgentRunner();
    const controller = new InProcessController(runner);
    const { clock, supervisor } = newSupervisor(controller, cfg());
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.attempt_id).not.toBeNull();
    expect(r.generation).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('fences a non-cancellable in-process attempt that hangs past the hard deadline', async () => {
    const runner = new FakeAgentRunner().on(
      () => true,
      () => new Promise(() => {}) as never, // never resolves — an in-process hang
    );
    const controller = new InProcessController(runner);
    const { clock, supervisor, paths } = newSupervisor(controller, cfg({ hard_timeout_ms: { worker: 4_000 } }));
    const task = makeTask();
    const p = supervisor.superviseTask(task);
    await clock.advance(0);
    await clock.advance(6_000); // hard deadline → cancel → no forceTerminate → fence
    const r = await p;
    expect(r.ok).toBe(false);
    const store = new TaskStore(paths);
    const rec = store.read('exec-01-T01')!;
    expect(rec.revoked_leases.length).toBeGreaterThan(0);
    expect(rec.workspace_id).toBeNull();
    expect(store.readEvents('exec-01-T01').some((e) => e.type === 'fenced')).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });
});

describe('supervisor — crash recovery reconciliation', () => {
  function writeRecord(paths: RijoPaths, over: Partial<Record<string, unknown>>): void {
    const store = new TaskStore(paths);
    const rec = TaskRecordSchema.parse({
      logical_task_id: 'exec-01-T01',
      attempt_id: 'exec-01-T01#g1-aaaa',
      generation: 1,
      lease_id: 'lease-1',
      idempotency_key: 'idem',
      role: 'worker',
      state: 'RUNNING',
      created_at: new Date().toISOString(),
      workspace_id: 'ws-1',
      workspace_path: '/tmp/ws-1',
      ...over,
    });
    // seed via create-like path (event + projection)
    store.emit(rec.logical_task_id, 'seed', {});
    // write directly through a transition-free path by faking a create
    (store as unknown as { create: (r: unknown) => unknown }).create(rec);
  }

  it('fences an orphan STARTING record with no recoverable handle and resumes it (budget remains)', async () => {
    const paths = tmpPaths();
    writeRecord(paths, { state: 'STARTING' });
    const report = await reconcileSupervisedTasks(paths, { maxReplacements: 2 });
    expect(report.total).toBe(1);
    expect(report.actions.resumed).toBe(1);
    expect(report.classifications['no_handle']).toBe(1);
    const rec = new TaskStore(paths).read('exec-01-T01')!;
    expect(rec.state).toBe('REPLACING');
    expect(rec.revoked_leases).toContain('lease-1'); // fenced
    expect(rec.workspace_id).toBeNull(); // workspace invalidated
  });

  it('fences an orphan RUNNING record and exhausts it when no replacement budget remains', async () => {
    const paths = tmpPaths();
    writeRecord(paths, { state: 'RUNNING' });
    const report = await reconcileSupervisedTasks(paths, { maxReplacements: 0 });
    expect(report.actions.exhausted).toBe(1);
    const rec = new TaskStore(paths).read('exec-01-T01')!;
    expect(rec.state).toBe('EXHAUSTED'); // terminal
    expect(rec.revoked_leases).toContain('lease-1');
    expect(rec.workspace_id).toBeNull();
  });

  it('discards a completed-but-unvalidated attempt with fencing (crash post-result/pre-apply)', async () => {
    const paths = tmpPaths();
    writeRecord(paths, { state: 'RUNNING' });
    const controller = new FakeController();
    controller.queryStatus = { kind: 'completed', detail: 'exit 0' };
    const handle: HostAttemptHandle = { attempt_id: 'x', lease_id: 'lease-1', generation: 1, host: 'fake', result: Promise.resolve({} as AgentResult) };
    const report = await reconcileSupervisedTasks(paths, { maxReplacements: 2, controllerLookup: () => ({ controller, handle }) });
    expect(report.classifications['completed_discarded']).toBe(1);
    expect(report.actions.resumed).toBe(1);
    const rec = new TaskStore(paths).read('exec-01-T01')!;
    expect(rec.state).toBe('REPLACING'); // discarded, not applied; queued for a fresh attempt
    expect(rec.revoked_leases).toContain('lease-1'); // completed result fenced out
    expect(rec.workspace_id).toBeNull();
  });

  it('fences a dead/disconnected attempt reported by the recovered handle', async () => {
    const paths = tmpPaths();
    writeRecord(paths, { state: 'RUNNING' });
    const controller = new FakeController();
    controller.queryStatus = { kind: 'dead' };
    const handle: HostAttemptHandle = { attempt_id: 'x', lease_id: 'lease-1', generation: 1, host: 'fake', result: Promise.resolve({} as AgentResult) };
    const report = await reconcileSupervisedTasks(paths, { maxReplacements: 2, controllerLookup: () => ({ controller, handle }) });
    expect(report.classifications['dead']).toBe(1);
    const rec = new TaskStore(paths).read('exec-01-T01')!;
    expect(rec.state).toBe('REPLACING');
    expect(rec.revoked_leases).toContain('lease-1');
  });

  it('is idempotent: a second reconciliation produces the same state and zero new events', async () => {
    const paths = tmpPaths();
    writeRecord(paths, { state: 'RUNNING' });
    await reconcileSupervisedTasks(paths, { maxReplacements: 2 });
    const store = new TaskStore(paths);
    const afterFirst = store.read('exec-01-T01')!.state;
    const eventsAfterFirst = store.readEvents('exec-01-T01').length;

    const second = await reconcileSupervisedTasks(paths, { maxReplacements: 2 });
    expect(second.total).toBe(0); // nothing left to reconcile
    expect(store.read('exec-01-T01')!.state).toBe(afterFirst);
    expect(store.readEvents('exec-01-T01').length).toBe(eventsAfterFirst); // no new events
  });

  it('starts a recovered FAILED task at the next generation without resetting fencing or budget', async () => {
    const paths = tmpPaths();
    writeRecord(paths, {
      state: 'FAILED',
      attempt_id: 'exec-01-T01#g2-bbbb',
      generation: 2,
      lease_id: 'lease-2',
      replacement_count: 1,
      revoked_leases: ['lease-1'],
      last_error: 'replacement workspace disappeared',
    });
    await reconcileSupervisedTasks(paths, { maxReplacements: 2 });

    const c = new FakeController();
    const { clock, supervisor } = newSupervisor(c, cfg({ max_replacements_per_task: 0 }), paths);
    const p = supervisor.superviseTask(
      makeTask('exec-01-T01', {
        workspace: { id: 'ws-exec-01-T01-g3', root: '/tmp/exec-01-T01-g3' },
      }),
    );
    await clock.advance(0);

    expect(c.started).toHaveLength(1);
    const generation3 = c.started[0]!.attempt!;
    expect(generation3.generation).toBe(3);
    expect(generation3.lease_id).not.toBe('lease-2');
    c.deliver(generation3.attempt_id, c.matching(generation3.attempt_id));
    await clock.advance(0);
    expect((await p).ok).toBe(true);

    const recovered = new TaskStore(paths).read('exec-01-T01')!;
    expect(recovered.generation).toBe(3);
    expect(recovered.replacement_count).toBe(2);
    expect(recovered.revoked_leases).toEqual(expect.arrayContaining(['lease-1', 'lease-2']));
    expect(recovered.revoked_leases).not.toContain(generation3.lease_id);
  });

  it('replays an exact SUCCEEDED identity without recreating or resetting its durable record', async () => {
    const paths = tmpPaths();
    const idempotencyKey = sha256('exec-01-T01').slice(0, 32);
    writeRecord(paths, {
      state: 'SUCCEEDED',
      attempt_id: 'exec-01-T01#g2-bbbb',
      generation: 2,
      lease_id: 'lease-2',
      replacement_count: 1,
      revoked_leases: ['lease-1'],
      finished_at: new Date().toISOString(),
      idempotency_key: idempotencyKey,
    });
    const c = new FakeController();
    c.replayIdentity = {
      logical_task_id: 'exec-01-T01',
      attempt_id: 'exec-01-T01#g2-bbbb',
      generation: 2,
      lease_id: 'lease-2',
      idempotency_key: idempotencyKey,
    };
    const { clock, supervisor } = newSupervisor(c, cfg(), paths);
    const p = supervisor.superviseTask(makeTask());
    await clock.advance(0);
    c.deliver(c.lastAttemptId(), c.matching(c.lastAttemptId()));
    await clock.advance(0);
    expect((await p).ok).toBe(true);

    const store = new TaskStore(paths);
    const replayed = store.read('exec-01-T01')!;
    expect(replayed.generation).toBe(2);
    expect(replayed.replacement_count).toBe(1);
    expect(replayed.revoked_leases).toEqual(['lease-1']);
    expect(store.readEvents('exec-01-T01').filter((event) => event.type === 'task_created')).toHaveLength(1);
  });

  it('never recreates an EXHAUSTED task and therefore cannot loop past its replacement bound', async () => {
    const paths = tmpPaths();
    writeRecord(paths, {
      state: 'FAILED',
      attempt_id: 'exec-01-T01#g3-cccc',
      generation: 3,
      lease_id: 'lease-3',
      replacement_count: 2,
      revoked_leases: ['lease-1', 'lease-2'],
      last_error: 'generation 3 failed',
    });
    await reconcileSupervisedTasks(paths, { maxReplacements: 2 });
    const store = new TaskStore(paths);
    const before = store.read('exec-01-T01')!;
    const createdBefore = store.readEvents('exec-01-T01').filter((event) => event.type === 'task_created').length;

    const c = new FakeController();
    const { supervisor } = newSupervisor(c, cfg({ max_replacements_per_task: 2 }), paths);
    const result = await supervisor.superviseTask(makeTask());

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('replacement budget already exhausted');
    expect(c.started).toHaveLength(0);
    expect(store.read('exec-01-T01')).toEqual(before);
    expect(store.readEvents('exec-01-T01').filter((event) => event.type === 'task_created')).toHaveLength(
      createdBefore,
    );
  });
});
