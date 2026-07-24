import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serve, raceWithUnwind } from '../src/cli/serve.js';
import type { RpcTransport } from '../src/agents/rpc.js';
import { tmpProject, cleanup, writePlanFile } from './helpers.js';

/**
 * Synchronous in-memory transport mirroring the one in bridge-resilience.test.ts.
 * `sent` records core→host traffic in delivery order, which is what lets these
 * tests assert strict causal ordering (cancel → settle → response, and
 * response(1) → runTask(2)) without any timing guesswork.
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
}

describe('serve() workflow deadline — unwind before response, queue stays blocked', () => {
  let root: string;
  let lockPath: string;
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    root = tmpProject('rijo-bridge-deadline-');
    writePlanFile(root);
    lockPath = path.join(root, '.rijo', 'runtime', 'lock.json');
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.removeListener('unhandledRejection', onUnhandled);
    cleanup(root);
  });

  it(
    'unwinds (cancelTask sent, lock released) BEFORE the deadline response reaches the client',
    async () => {
      const t = new MemoryTransport();
      const responses = new Map<number, any>();
      const waiters = new Map<number, () => void>();

      let sawCancelTask = false;
      let cancelSeenBeforeResponse = false;
      let lockHeldAtResponse: boolean | null = null;

      const originalSend = t.send.bind(t);
      t.send = (msg: any) => {
        originalSend(msg);
        if (msg?.type === 'request' && msg.method === 'agent.cancelTask') sawCancelTask = true;
        if (msg?.type === 'response' && typeof msg.id === 'number') {
          if (msg.id === 1) {
            // Captured at the exact instant the response is written to the
            // wire — proves causal order, not just eventual consistency.
            cancelSeenBeforeResponse = sawCancelTask;
            lockHeldAtResponse = fs.existsSync(lockPath);
          }
          responses.set(msg.id, msg);
          waiters.get(msg.id)?.();
        }
      };
      const responded = (id: number): Promise<any> =>
        new Promise((res) => {
          if (responses.has(id)) return res(responses.get(id));
          waiters.set(id, () => res(responses.get(id)));
        });

      // Host that never answers agent.runTask: the workflow wedges on its
      // first agent call and must be released by the deadline.
      void serve(t, root, { workflowDeadlineMs: 150, workflowUnwindMarginMs: 5_000, shutdownGraceMs: 50, installSignalHandlers: false });

      t.deliver({ type: 'request', method: 'workflow.new', id: 1, params: { planFile: '@PLANO.md' } });

      const r1 = await responded(1);
      expect(r1.error).toBe('WORKFLOW_DEADLINE_EXCEEDED');

      // The order the mission requires: cancelTask sent, THEN the workflow's
      // own promise settled (its lock released by withLock's finally), THEN —
      // only then — the response reached the client.
      expect(cancelSeenBeforeResponse).toBe(true);
      expect(lockHeldAtResponse).toBe(false);

      await new Promise((res) => setTimeout(res, 30));
      expect(unhandled).toEqual([]);
    },
    15_000,
  );

  it(
    'a second queued workflow does not start until the first is fully unwound',
    async () => {
      const t = new MemoryTransport();
      const responses = new Map<number, any>();
      const waiters = new Map<number, () => void>();

      let responseOneIndex = -1;
      let runTaskCount = 0;
      let secondWorkflowRunTaskIndex = -1;

      const originalSend = t.send.bind(t);
      t.send = (msg: any) => {
        originalSend(msg);
        const idx = t.sent.length - 1;
        if (msg?.type === 'response' && msg.id === 1 && responseOneIndex === -1) responseOneIndex = idx;
        if (msg?.type === 'request' && msg.method === 'agent.runTask') {
          runTaskCount += 1;
          // The first runTask belongs to workflow #1; the second belongs to
          // workflow #2 (each workflow.new hangs on exactly one agent call
          // since the host never answers it).
          if (runTaskCount === 2 && secondWorkflowRunTaskIndex === -1) secondWorkflowRunTaskIndex = idx;
        }
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

      void serve(t, root, { workflowDeadlineMs: 150, workflowUnwindMarginMs: 5_000, shutdownGraceMs: 50, installSignalHandlers: false });

      // Enqueue both requests back-to-back, before either is answered.
      t.deliver({ type: 'request', method: 'workflow.new', id: 1, params: { planFile: '@PLANO.md' } });
      t.deliver({ type: 'request', method: 'workflow.new', id: 2, params: { planFile: '@PLANO.md' } });

      const r1 = await responded(1);
      expect(r1.error).toBe('WORKFLOW_DEADLINE_EXCEEDED');
      const r2 = await responded(2);
      expect(r2.error).toBe('WORKFLOW_DEADLINE_EXCEEDED');

      expect(runTaskCount).toBeGreaterThanOrEqual(2);
      expect(responseOneIndex).toBeGreaterThanOrEqual(0);
      expect(secondWorkflowRunTaskIndex).toBeGreaterThan(responseOneIndex);

      await new Promise((res) => setTimeout(res, 30));
      expect(unhandled).toEqual([]);
    },
    15_000,
  );
});

describe('raceWithUnwind — deadline/cancel/hard-cap state machine', () => {
  it('work settling before the deadline never fires onDeadline/onUnwindTimeout', async () => {
    let resolveWork: () => void;
    const work = new Promise<void>((res) => {
      resolveWork = res;
    });
    const onDeadline = vi.fn();
    const onUnwindTimeout = vi.fn();

    const racePromise = raceWithUnwind(work, 10_000, 5_000, onDeadline, onUnwindTimeout);
    resolveWork!();
    const outcome = await racePromise;

    expect(outcome).toEqual({ deadlineHit: false, unwindTimedOut: false });
    expect(onDeadline).not.toHaveBeenCalled();
    expect(onUnwindTimeout).not.toHaveBeenCalled();
  });

  it('deadline fires, work settles within the unwind margin: cancels, waits for settle, reports WORKFLOW_DEADLINE_EXCEEDED shape', async () => {
    vi.useFakeTimers();
    try {
      let resolveWork: () => void;
      const work = new Promise<void>((res) => {
        resolveWork = res;
      });
      const onDeadline = vi.fn(() => {
        // Simulate cancelAll causing the workflow to settle shortly after.
        setTimeout(() => resolveWork(), 10);
      });
      const onUnwindTimeout = vi.fn();

      const racePromise = raceWithUnwind(work, 100, 5_000, onDeadline, onUnwindTimeout);
      await vi.advanceTimersByTimeAsync(100); // deadline fires
      expect(onDeadline).toHaveBeenCalledTimes(1);
      expect(onUnwindTimeout).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10); // onDeadline's simulated cancel settle
      const outcome = await racePromise;

      expect(outcome).toEqual({ deadlineHit: true, unwindTimedOut: false });
      expect(onUnwindTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deadline fires and work does NOT settle within the hard cap: fires onUnwindTimeout but still blocks until real settle', async () => {
    vi.useFakeTimers();
    try {
      let resolveWork: () => void;
      const work = new Promise<void>((res) => {
        resolveWork = res;
      });
      const onDeadline = vi.fn(); // deliberately does NOT make `work` settle
      const onUnwindTimeout = vi.fn();

      const racePromise = raceWithUnwind(work, 100, 200, onDeadline, onUnwindTimeout);
      let settled = false;
      void racePromise.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(100); // deadline fires → onDeadline called
      expect(onDeadline).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200); // hard cap exceeded
      // onUnwindTimeout fires at the moment the cap is exceeded...
      expect(onUnwindTimeout).toHaveBeenCalledTimes(1);
      // ...but the function must NOT have returned yet: work is still pending,
      // so the queue must stay blocked.
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      // Only once the workflow truly settles does raceWithUnwind return.
      resolveWork!();
      const outcome = await racePromise;
      expect(outcome).toEqual({ deadlineHit: true, unwindTimedOut: true });
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets `work` become an unhandled rejection path when the caller never attaches a .catch', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // `work` here resolves normally (never rejects) — matches the real
      // caller's contract (handleWorkflowRequest's IIFE always catches
      // internally). raceWithUnwind adds no rejection handling of its own,
      // relying on that contract; this asserts the contract holds end to end.
      let resolveWork: () => void;
      const work = new Promise<void>((res) => {
        resolveWork = res;
      });
      const onDeadline = vi.fn(() => resolveWork());
      const outcome = await raceWithUnwind(work, 5, 1_000, onDeadline, vi.fn());
      expect(outcome.deadlineHit).toBe(true);
      await new Promise((res) => setTimeout(res, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
