/**
 * Injectable clock. Every wait in the supervisor is scheduled through a Clock
 * so tests can drive time deterministically (FakeClock) while production uses
 * wall-clock timers (SystemClock). No supervisor code ever calls the global
 * setTimeout/Date.now directly — that is the whole point: bounded, testable
 * time.
 */

export interface TimerHandle {
  readonly id: number;
}

export interface Clock {
  /** Monotonic-enough milliseconds. FakeClock starts at 0 and only moves on advance(). */
  now(): number;
  /** Schedule `fn` after `delayMs`. Returns a handle for clearTimer. */
  setTimer(fn: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

/** Real wall-clock implementation. Timers are unref'd so a settled test/process can exit. */
export class SystemClock implements Clock {
  private seq = 0;
  private readonly timers = new Map<number, NodeJS.Timeout>();

  now(): number {
    return Date.now();
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = ++this.seq;
    const t = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, Math.max(0, delayMs));
    t.unref?.();
    this.timers.set(id, t);
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    const t = this.timers.get(handle.id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(handle.id);
    }
  }
}

interface FakeTimer {
  id: number;
  at: number;
  order: number;
  fn: () => void;
}

/**
 * Deterministic clock for tests. Time only advances via `advance(ms)`, which
 * fires every timer due at or before the new time, in scheduled order, flushing
 * microtasks between each so awaited async callbacks (heartbeat probes, cancel
 * receipts) fully progress before the next timer fires.
 */
export class FakeClock implements Clock {
  private current = 0;
  private seq = 0;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimer(fn: () => void, delayMs: number): TimerHandle {
    const id = ++this.seq;
    this.timers.push({ id, at: this.current + Math.max(0, delayMs), order: id, fn });
    return { id };
  }

  clearTimer(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== handle.id);
  }

  /** Number of still-scheduled timers. Used by tests to assert no orphan timers remain. */
  get pendingTimers(): number {
    return this.timers.length;
  }

  /**
   * Advance virtual time by `totalMs`, firing due timers in order. Between each
   * firing we drain the microtask queue so async callbacks that schedule the
   * next timer are observed within the same advance call.
   */
  async advance(totalMs: number): Promise<void> {
    const target = this.current + Math.max(0, totalMs);
    let guard = 0;
    for (;;) {
      if (++guard > 1_000_000) throw new Error('FakeClock.advance: timer storm (possible 0ms reschedule loop)');
      let due: FakeTimer | undefined;
      for (const t of this.timers) {
        if (t.at <= target && (due === undefined || t.at < due.at || (t.at === due.at && t.order < due.order))) {
          due = t;
        }
      }
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due!.id);
      this.current = due.at;
      due.fn();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

/** Drain the microtask + immediate queues several times so chained awaits settle. */
export async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
