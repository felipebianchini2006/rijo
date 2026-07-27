import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serve } from '../src/cli/serve.js';
import { RpcAgentRunner, type RpcTransport } from '../src/agents/rpc.js';
import { AgentTaskSchema, type AgentTask } from '../src/agents/protocol.js';
import type { RunnerCapabilities } from '../src/agents/runner.js';
import { tmpProject, cleanup, writePlanFile } from './helpers.js';

const CAPS: RunnerCapabilities = { subagents: true, parallelism: false, browser: false };

/**
 * Synchronous in-memory transport. `sent` records core→host traffic; `deliver`
 * injects host→core messages; `end`/`error` drive the disconnect paths. Delivery
 * is synchronous so assertions can run immediately after — no timers, no clocks.
 */
class MemoryTransport implements RpcTransport {
  public readonly sent: any[] = [];
  private readonly handlers: Array<(m: any) => void> = [];
  private readonly endCbs: Array<() => void> = [];
  private readonly errorCbs: Array<(e: unknown) => void> = [];

  send(msg: unknown): void {
    this.sent.push(msg);
  }
  onMessage(cb: (m: any) => void): void {
    this.handlers.push(cb);
  }
  onEnd(cb: () => void): void {
    this.endCbs.push(cb);
  }
  onError(cb: (e: unknown) => void): void {
    this.errorCbs.push(cb);
  }

  deliver(msg: unknown): void {
    for (const h of [...this.handlers]) h(msg);
  }
  end(): void {
    for (const c of [...this.endCbs]) c();
  }
  error(e: unknown = new Error('pipe')): void {
    for (const c of [...this.errorCbs]) c(e);
  }

  /** The last agent.runTask request id the runner emitted. */
  lastRunTaskId(): number {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i];
      if (m?.type === 'request' && m.method === 'agent.runTask') return m.id as number;
    }
    throw new Error('no agent.runTask request was sent');
  }
  countMethod(method: string): number {
    return this.sent.filter((m) => m?.method === method).length;
  }
}

function task(id: string, extra: Partial<AgentTask> = {}): AgentTask {
  return AgentTaskSchema.parse({
    id,
    role: 'worker',
    objective: `do ${id}`,
    return_format: 'text',
    ...extra,
  });
}

function supervised(id: string, attemptId: string): AgentTask {
  return task(id, {
    attempt: {
      logical_task_id: id,
      attempt_id: attemptId,
      generation: 1,
      lease_id: `lease-${attemptId}`,
      idempotency_key: `idem-${attemptId}`,
    },
  });
}

describe('bridge resilience — RpcAgentRunner', () => {
  it('resolves ok:false HOST_TIMEOUT and clears the timer on host silence', async () => {
    vi.useFakeTimers();
    try {
      const t = new MemoryTransport();
      const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 1000 });
      const p = runner.runTask(task('t1'));

      expect(runner.listPending()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);

      const res = await p;
      expect(res.ok).toBe(false);
      expect(res.summary).toBe('HOST_TIMEOUT');
      // timer cleared + pending removed
      expect(runner.listPending()).toHaveLength(0);
      // a late host reply after timeout must not throw / re-resolve anything
      t.deliver({ type: 'response', id: t.lastRunTaskId(), result: { task_id: 't1', ok: true, summary: 'late' } });
      expect(runner.listPending()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a per-task timeoutMs override', async () => {
    vi.useFakeTimers();
    try {
      const t = new MemoryTransport();
      const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 10_000 });
      const p = runner.runTask(task('t1'), { timeoutMs: 200 });
      await vi.advanceTimersByTimeAsync(200);
      const res = await p;
      expect(res.summary).toBe('HOST_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('EOF rejects-resolves ALL pendings with HOST_DISCONNECTED and clears them', async () => {
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000 });
    const p1 = runner.runTask(task('a'));
    const p2 = runner.runTask(task('b'));
    expect(runner.listPending()).toHaveLength(2);

    t.end();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r1.summary).toBe('HOST_DISCONNECTED');
    expect(r2.summary).toBe('HOST_DISCONNECTED');
    expect(runner.listPending()).toHaveLength(0);
  });

  it('a transport error resolves all pendings with HOST_DISCONNECTED', async () => {
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000 });
    const p = runner.runTask(task('a'));
    t.error(new Error('broken pipe'));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('HOST_DISCONNECTED');
  });

  it('is idempotent on a duplicate response: first wins, later ones go to onLate', async () => {
    const late: number[] = [];
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000, onLate: (id) => late.push(id) });
    const p = runner.runTask(task('a'));
    const id = t.lastRunTaskId();

    t.deliver({ type: 'response', id, result: { task_id: 'a', ok: true, summary: 'first' } });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('first');

    // duplicate for the same (now-settled) id → ignored, reported to onLate
    t.deliver({ type: 'response', id, result: { task_id: 'a', ok: true, summary: 'second' } });
    expect(late).toEqual([id]);
  });

  it('accepts the agent.result notification alias for a runTask response', async () => {
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000 });
    const p = runner.runTask(task('a'));
    const id = t.lastRunTaskId();
    t.deliver({ type: 'notification', method: 'agent.result', params: { id, result: { task_id: 'a', ok: true, summary: 'via-alias' } } });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('via-alias');
  });

  it('a divergent attempt echo does NOT resolve the supervised pending', async () => {
    vi.useFakeTimers();
    try {
      const t = new MemoryTransport();
      const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 5000 });
      const p = runner.runTask(supervised('a', 'A1'));
      const id = t.lastRunTaskId();

      // stale/misrouted reply with the wrong attempt echo → discarded, pending stays
      t.deliver({ type: 'response', id, result: { task_id: 'a', ok: true, summary: 'stale', attempt_id: 'WRONG', generation: 1, lease_id: 'lease-A1' } });
      expect(runner.listPending()).toHaveLength(1);

      // the correct echo resolves it
      t.deliver({ type: 'response', id, result: { task_id: 'a', ok: true, summary: 'right', attempt_id: 'A1', generation: 1, lease_id: 'lease-A1' } });
      const r = await p;
      expect(r.ok).toBe(true);
      expect(r.summary).toBe('right');
      expect(runner.listPending()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a response for an unknown id never resolves any task', async () => {
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000 });
    const p = runner.runTask(task('a'));
    // id 999 was never dispatched → ignored entirely, pending untouched
    t.deliver({ type: 'response', id: 999, result: { task_id: 'a', ok: true, summary: 'stranger' } });
    expect(runner.listPending()).toHaveLength(1);
    // resolve legitimately to avoid a dangling promise
    t.deliver({ type: 'response', id: t.lastRunTaskId(), result: { task_id: 'a', ok: true, summary: 'ok' } });
    expect((await p).summary).toBe('ok');
  });

  it('an AbortSignal cancels the task on the host and resolves ok:false CANCELLED', async () => {
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000 });
    const ctrl = new AbortController();
    const p = runner.runTask(supervised('a', 'A1'), { signal: ctrl.signal });

    ctrl.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('CANCELLED');
    expect(runner.listPending()).toHaveLength(0);

    // it told the host to cancel, echoing the attempt/lease identity
    const cancel = t.sent.find((m) => m?.method === 'agent.cancelTask');
    expect(cancel).toBeTruthy();
    expect(cancel.params.attempt_id).toBe('A1');
    expect(cancel.params.lease_id).toBe('lease-A1');
  });

  it('a signal already aborted at dispatch resolves CANCELLED without dispatching', async () => {
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000 });
    const r = await runner.runTask(task('a'), { signal: AbortSignal.abort() });
    expect(r.summary).toBe('CANCELLED');
    expect(t.countMethod('agent.runTask')).toBe(0);
  });

  it('reports heartbeat and progress notifications to its callbacks', () => {
    const beats: Array<[string | null, string | null]> = [];
    const progress: Array<[string | null, string | null, unknown]> = [];
    const t = new MemoryTransport();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const runner = new RpcAgentRunner(t, CAPS, {
      onHeartbeat: (a, l) => beats.push([a, l]),
      onProgress: (a, l, d) => progress.push([a, l, d]),
    });
    void runner;
    t.deliver({ type: 'notification', method: 'agent.heartbeat', params: { attempt_id: 'A1', lease_id: 'L1' } });
    t.deliver({ type: 'notification', method: 'agent.progress', params: { attempt_id: 'A1', lease_id: 'L1', detail: 'compiling' } });
    expect(beats).toEqual([['A1', 'L1']]);
    expect(progress).toEqual([['A1', 'L1', 'compiling']]);
  });

  it('listPending exposes id, taskId, attempt_id and ageMs', () => {
    let clock = 1000;
    const t = new MemoryTransport();
    const runner = new RpcAgentRunner(t, CAPS, { defaultTimeoutMs: 60_000, now: () => clock });
    void runner.runTask(supervised('a', 'A1'));
    void runner.runTask(task('b'));
    clock = 1250;

    const snap = runner.listPending();
    expect(snap).toHaveLength(2);
    const a = snap.find((s) => s.taskId === 'a')!;
    expect(a.attempt_id).toBe('A1');
    expect(a.ageMs).toBe(250);
    expect(typeof a.id).toBe('number');
    const b = snap.find((s) => s.taskId === 'b')!;
    expect(b.attempt_id).toBeNull();
  });
});

describe('bridge resilience — serve workflow deadline', () => {
  let root: string;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    root = tmpProject('rijo-bridge-resil-');
    writePlanFile(root);
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.removeListener('unhandledRejection', onUnhandled);
    cleanup(root);
  });

  it('a workflow deadline responds with an error and frees the queue for the next request', async () => {
    const t = new MemoryTransport();
    const responses = new Map<number, any>();
    const startedTasks: string[] = [];
    const waiters = new Map<number, () => void>();

    // A host that NEVER answers agent.runTask → every workflow wedges on its
    // first agent call and must be released by the deadline. All core→host
    // traffic (including the agent.runTask requests and workflow responses)
    // flows through send.
    const originalSend = t.send.bind(t);
    t.send = (msg: any) => {
      originalSend(msg);
      if (msg?.type === 'request' && msg.method === 'agent.runTask') startedTasks.push(msg.params.id);
      if (msg?.type === 'response' && typeof msg.id === 'number') {
        responses.set(msg.id, msg);
        waiters.get(msg.id)?.();
      }
    };
    const responded = (id: number): Promise<any> =>
      new Promise((res) => {
        if (responses.has(id)) return res(responses.get(id));
        waiters.set(id, () => res(responses.get(id)));
      });

    void serve(t, root, { workflowDeadlineMs: 300, shutdownGraceMs: 50, installSignalHandlers: false });

    // Two queued workflows; both hang on their first agent task and rely on the
    // deadline to unblock the queue.
    t.deliver({ type: 'request', method: 'workflow.new', id: 1, params: { planFile: '@PLAN.md' } });
    t.deliver({ type: 'request', method: 'workflow.new', id: 2, params: { planFile: '@PLAN.md' } });

    // First workflow times out → error response, queue advances.
    const r1 = await responded(1);
    expect(r1.error).toBe('WORKFLOW_DEADLINE_EXCEEDED');

    // The queue was freed: the second workflow is processed and also deadlines
    // out. Getting ANY response for id 2 proves the chain did not wedge.
    const r2 = await responded(2);
    expect(r2.error).toBe('WORKFLOW_DEADLINE_EXCEEDED');

    // Both workflows actually reached the host (dispatched agent tasks).
    expect(startedTasks.length).toBeGreaterThanOrEqual(2);

    // Let any trailing background settlement flush before the test ends.
    await new Promise((res) => setTimeout(res, 50));

    // No agent.runTask promise ever became an unhandled rejection.
    expect(unhandled).toEqual([]);
  }, 15_000);
});
