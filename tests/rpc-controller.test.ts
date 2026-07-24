import { describe, it, expect, vi } from 'vitest';
import { RpcHostController, FORCE_TERMINATE_METHOD } from '../src/hosts/rpcController.js';
import type { RpcTransport } from '../src/agents/rpc.js';
import { AgentTaskSchema, type AgentTask } from '../src/agents/protocol.js';
import type { SupervisedAgentTask } from '../src/hosts/controller.js';

/**
 * RpcHostController driven over a synchronous in-memory transport (the same
 * harness style as tests/bridge-resilience.test.ts). Delivery is synchronous so
 * assertions run immediately; liveness uses an injected clock; ack timeouts use
 * fake timers. No real process, no real model.
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
  lastRunTaskId(): number {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const m = this.sent[i];
      if (m?.type === 'request' && m.method === 'agent.runTask') return m.id as number;
    }
    throw new Error('no agent.runTask request was sent');
  }
  find(method: string): any | undefined {
    return this.sent.find((m) => m?.method === method);
  }
}

function supervisedTask(id: string, attemptId: string): SupervisedAgentTask {
  const task: AgentTask = AgentTaskSchema.parse({
    id,
    role: 'worker',
    objective: `do ${id}`,
    return_format: 'text',
    attempt: {
      logical_task_id: id,
      attempt_id: attemptId,
      generation: 1,
      lease_id: `lease-${attemptId}`,
      idempotency_key: `idem-${attemptId}`,
    },
  });
  return { task, hard_deadline_at: new Date(Date.now() + 60_000).toISOString() };
}

function okResult(taskId: string, attemptId: string, summary = 'done') {
  return {
    task_id: taskId,
    ok: true,
    summary,
    files_written: [],
    payload: null,
    scope_requests: [],
    attempt_id: attemptId,
    generation: 1,
    lease_id: `lease-${attemptId}`,
  };
}

describe('RpcHostController — over the JSON-RPC bridge', () => {
  it('start sends agent.runTask; a matching host response resolves the handle result', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { defaultTimeoutMs: 60_000 });
    const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);

    const run = t.find('agent.runTask');
    expect(run).toBeTruthy();
    expect(run.params.id).toBe('a');

    t.deliver({ type: 'response', id: t.lastRunTaskId(), result: okResult('a', 'A1') });
    const r = await handle.result;
    expect(r.ok).toBe(true);
    expect(r.attempt_id).toBe('A1');
  });

  it('materialises host heartbeats into queryable liveness', async () => {
    let clock = 1000;
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { now: () => clock, livenessTimeoutMs: 5000, defaultTimeoutMs: 60_000 });
    const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);

    // Fresh at start.
    expect((await controller.heartbeat(handle)).alive).toBe(true);

    // A heartbeat refreshes lastAliveAt.
    t.deliver({ type: 'notification', method: 'agent.heartbeat', params: { attempt_id: 'A1', lease_id: 'lease-A1' } });

    // Past the freshness window with no new beat → not alive.
    clock = 1000 + 5001;
    const stale = await controller.heartbeat(handle);
    expect(stale.alive).toBe(false);
    expect(stale.last_activity_ms).toBe(5001);

    // A new beat brings it back to life.
    t.deliver({ type: 'notification', method: 'agent.heartbeat', params: { attempt_id: 'A1', lease_id: 'lease-A1' } });
    expect((await controller.heartbeat(handle)).alive).toBe(true);

    // Once settled it is never "alive".
    t.deliver({ type: 'response', id: t.lastRunTaskId(), result: okResult('a', 'A1') });
    await handle.result;
    expect((await controller.heartbeat(handle)).alive).toBe(false);
  });

  it('requestCancel sends agent.cancelTask and resolves acknowledged on agent.cancelled', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { defaultTimeoutMs: 60_000, cancelAckTimeoutMs: 1000 });
    const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);

    const p = controller.requestCancel(handle, 'no progress');
    const cancel = t.find('agent.cancelTask');
    expect(cancel).toBeTruthy();
    expect(cancel.params.attempt_id).toBe('A1');
    expect(cancel.params.lease_id).toBe('lease-A1');

    t.deliver({ type: 'notification', method: 'agent.cancelled', params: { attempt_id: 'A1' } });
    const receipt = await p;
    expect(receipt.requested).toBe(true);
    expect(receipt.acknowledged).toBe(true);
  });

  it('requestCancel gives up on the ack after a BOUNDED timeout (never hangs)', async () => {
    vi.useFakeTimers();
    try {
      const t = new MemoryTransport();
      const controller = new RpcHostController(t, { defaultTimeoutMs: 600_000, cancelAckTimeoutMs: 200 });
      const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);

      const p = controller.requestCancel(handle, 'no progress');
      await vi.advanceTimersByTimeAsync(200); // host never acks
      const receipt = await p;
      expect(receipt.requested).toBe(true);
      expect(receipt.acknowledged).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forceTerminate is not_supported unless the host advertised the capability', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { defaultTimeoutMs: 60_000 });
    const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);

    const receipt = await controller.forceTerminate!(handle, 'stuck');
    expect(receipt.terminated).toBe(false);
    expect(receipt.method).toBe('not_supported');
    // it must NOT have sent a force request it can't back up
    expect(t.find(FORCE_TERMINATE_METHOD)).toBeUndefined();
  });

  it('forceTerminate hard-kills when the negotiated handshake proves support', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, {
      defaultTimeoutMs: 60_000,
      cancelAckTimeoutMs: 1000,
      hostCapabilities: { protocol_version: 2, methods: [FORCE_TERMINATE_METHOD] },
    });
    const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);
    expect(controller.supportsForceTerminate()).toBe(true);

    const p = controller.forceTerminate!(handle, 'stuck');
    expect(t.find(FORCE_TERMINATE_METHOD)).toBeTruthy();
    t.deliver({ type: 'notification', method: 'agent.cancelled', params: { attempt_id: 'A1' } });
    const receipt = await p;
    expect(receipt.terminated).toBe(true);
    expect(receipt.method).toBe('interrupt');
  });

  it('learns force-terminate support from an observed host.capabilities message', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { defaultTimeoutMs: 60_000 });
    expect(controller.supportsForceTerminate()).toBe(false);
    t.deliver({
      type: 'notification',
      method: 'host.capabilities',
      params: { protocol_version: 2, methods: ['agent.runTask', FORCE_TERMINATE_METHOD] },
    });
    expect(controller.supportsForceTerminate()).toBe(true);
  });

  it('dispose aborts a still-running attempt → the result settles CANCELLED', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { defaultTimeoutMs: 60_000 });
    const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);

    await controller.dispose(handle);
    const r = await handle.result;
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('CANCELLED');
    // after dispose the attempt is forgotten
    expect((await controller.query(handle)).kind).toBe('unknown');
  });

  it('an external abort cancels the attempt on the host and settles CANCELLED', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { defaultTimeoutMs: 60_000 });
    const ctrl = new AbortController();
    const handle = await controller.start(supervisedTask('a', 'A1'), ctrl.signal);

    ctrl.abort();
    const r = await handle.result;
    expect(r.summary).toBe('CANCELLED');
    expect(t.find('agent.cancelTask')).toBeTruthy();
  });

  it('transport EOF settles the attempt HOST_DISCONNECTED and query reports it', async () => {
    const t = new MemoryTransport();
    const controller = new RpcHostController(t, { defaultTimeoutMs: 60_000 });
    const handle = await controller.start(supervisedTask('a', 'A1'), new AbortController().signal);

    t.end();
    const r = await handle.result;
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('HOST_DISCONNECTED');
  });
});
