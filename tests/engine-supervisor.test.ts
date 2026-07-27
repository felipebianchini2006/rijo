import { describe, expect, it } from 'vitest';
import {
  EngineSupervisor,
  type EngineExit,
  type EngineProcessFactory,
  type EngineProcessHandle,
  type EngineRunStatus,
  type EngineSupervisorLedger,
  type EngineSupervisorReceipt,
} from '../src/supervisor/engineSupervisor.js';

class TestLedger implements EngineSupervisorLedger {
  status: EngineRunStatus | null = null;
  progress = { sequence: 0, observed_at: new Date().toISOString() };
  generation = 0;
  leaseAvailable = true;
  advanceProgressOnRead = false;
  receipts: EngineSupervisorReceipt[] = [];
  fenced: Array<{ generation: number; reason: string }> = [];
  reconciled: number[] = [];
  reconciliationSafe = true;
  released: string[] = [];
  blockedReasons: string[] = [];
  terminatedGenerations: number[] = [];
  terminationSafe = true;

  async acquireSupervisorLease(): Promise<boolean> {
    return this.leaseAvailable;
  }

  async releaseSupervisorLease(ownerId: string): Promise<void> {
    this.released.push(ownerId);
  }

  async readRunStatus(): Promise<EngineRunStatus | null> {
    return this.status;
  }

  async readProgress(): Promise<{ sequence: number; observed_at: string }> {
    if (this.advanceProgressOnRead) {
      this.progress = { sequence: this.progress.sequence + 1, observed_at: new Date().toISOString() };
    }
    return this.progress;
  }

  async readLastEngineGeneration(): Promise<number> {
    return this.generation;
  }

  async appendSupervisorReceipt(receipt: EngineSupervisorReceipt): Promise<void> {
    this.receipts.push(receipt);
    if (receipt.type === 'engine.started') this.generation = receipt.generation;
  }

  async markRunBlocked(reason: string): Promise<void> {
    this.blockedReasons.push(reason);
    this.status = 'BLOCKED';
  }

  async terminateEngineGeneration(
    generation: number,
  ): Promise<{ engine_tree_gone: boolean }> {
    this.terminatedGenerations.push(generation);
    return { engine_tree_gone: this.terminationSafe };
  }

  async fenceEngineGeneration(generation: number, reason: string): Promise<void> {
    this.fenced.push({ generation, reason });
  }

  async reconcileEngineGeneration(generation: number): Promise<{ engine_tree_gone: boolean }> {
    this.reconciled.push(generation);
    return { engine_tree_gone: this.reconciliationSafe };
  }
}

class TestHandle implements EngineProcessHandle {
  readonly pid: number;
  readonly process_group: number;
  readonly result: Promise<EngineExit>;
  alive = true;
  terminations: Array<'term' | 'kill'> = [];
  private settle!: (exit: EngineExit) => void;

  constructor(pid: number) {
    this.pid = pid;
    this.process_group = pid;
    this.result = new Promise<EngineExit>((resolve) => {
      this.settle = resolve;
    });
  }

  exit(exit: EngineExit): void {
    if (!this.alive) return;
    this.alive = false;
    this.settle(exit);
  }

  isAlive(): boolean {
    return this.alive;
  }

  async terminate(mode: 'term' | 'kill'): Promise<boolean> {
    this.terminations.push(mode);
    if (mode === 'kill') this.exit({ code: null, signal: 'SIGKILL' });
    return !this.alive;
  }
}

class TestFactory implements EngineProcessFactory {
  readonly handles: TestHandle[] = [];
  active = 0;
  maximumActive = 0;
  startFailures = 0;

  async start(): Promise<EngineProcessHandle> {
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new Error('spawn unavailable');
    }
    const handle = new TestHandle(10_000 + this.handles.length);
    this.handles.push(handle);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    void handle.result.finally(() => {
      this.active -= 1;
    });
    return handle;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function createSupervisor(
  ledger: TestLedger,
  factory: TestFactory,
  overrides: Partial<ConstructorParameters<typeof EngineSupervisor>[0]['config']> = {},
): EngineSupervisor {
  return new EngineSupervisor({
    ledger,
    processFactory: factory,
    config: {
      poll_interval_ms: 2,
      no_progress_timeout_ms: 50,
      hard_deadline_ms: 2_000,
      cancel_grace_ms: 2,
      kill_grace_ms: 2,
      max_restarts: 2,
      ...overrides,
    },
  });
}

describe('engine supervisor state machine', () => {
  it('does not launch an engine when the run is already terminal', async () => {
    const ledger = new TestLedger();
    ledger.status = 'READY';
    const factory = new TestFactory();

    const result = await createSupervisor(ledger, factory).run();

    expect(result).toMatchObject({ status: 'READY', state: 'READY', restarts: 0 });
    expect(factory.handles).toHaveLength(0);
    expect(ledger.released).toHaveLength(1);
  });

  it('reconciles a recorded engine generation before returning an existing terminal run', async () => {
    const ledger = new TestLedger();
    ledger.status = 'READY';
    ledger.generation = 2;
    const factory = new TestFactory();

    const result = await createSupervisor(ledger, factory).run();

    expect(result).toMatchObject({ status: 'READY', state: 'READY', generation: 2 });
    expect(factory.handles).toHaveLength(0);
    expect(ledger.terminatedGenerations).toEqual([2]);
    expect(ledger.fenced).toEqual([{ generation: 2, reason: 'terminal supervisor recovery' }]);
    expect(ledger.reconciled).toEqual([2]);
  });

  it('allows only one supervisor lease and never starts a competing engine', async () => {
    const ledger = new TestLedger();
    ledger.leaseAvailable = false;
    const factory = new TestFactory();

    const result = await createSupervisor(ledger, factory).run();

    expect(result).toMatchObject({ status: 'BLOCKED', state: 'BLOCKED' });
    expect(factory.handles).toHaveLength(0);
    expect(ledger.receipts.at(-1)).toMatchObject({ type: 'supervisor.lock_denied' });
  });

  it('fences and reconciles a crashed engine before starting its replacement', async () => {
    const ledger = new TestLedger();
    const factory = new TestFactory();
    const running = createSupervisor(ledger, factory).run();
    await waitFor(() => factory.handles.length === 1);

    factory.handles[0]!.exit({ code: 17, signal: null });
    await waitFor(() => factory.handles.length === 2);
    ledger.status = 'READY';

    const result = await running;

    expect(result).toMatchObject({ status: 'READY', state: 'READY', generation: 2, restarts: 1 });
    expect(ledger.fenced).toEqual([{ generation: 1, reason: expect.stringContaining('exit 17') }]);
    expect(ledger.reconciled).toEqual([1]);
    expect(factory.maximumActive).toBe(1);
  });

  it('treats a spawn failure as a bounded generation failure and recovers', async () => {
    const ledger = new TestLedger();
    const factory = new TestFactory();
    factory.startFailures = 1;
    const running = createSupervisor(ledger, factory).run();
    await waitFor(() => factory.handles.length === 1);
    ledger.status = 'READY';

    const result = await running;

    expect(result).toMatchObject({ status: 'READY', generation: 2, restarts: 1 });
    expect(ledger.fenced[0]).toMatchObject({
      generation: 1,
      reason: 'engine spawn failed: spawn unavailable',
    });
  });

  it('terminates a hung engine tree, fences it, and only then restarts', async () => {
    const ledger = new TestLedger();
    const factory = new TestFactory();
    const running = createSupervisor(ledger, factory, {
      no_progress_timeout_ms: 8,
      hard_deadline_ms: 1_000,
    }).run();
    await waitFor(() => factory.handles.length === 2, 1_000);
    ledger.status = 'READY';

    const result = await running;

    expect(result.status).toBe('READY');
    expect(factory.handles[0]!.terminations).toEqual(['term', 'kill']);
    expect(ledger.fenced[0]).toMatchObject({
      generation: 1,
      reason: expect.stringContaining('no ledger progress'),
    });
    expect(ledger.receipts).toContainEqual(
      expect.objectContaining({
        type: 'supervisor.heartbeat',
        supervisor_pid: process.pid,
        pid: factory.handles[0]!.pid,
        process_group: process.platform === 'win32' ? null : factory.handles[0]!.pid,
      }),
    );
    expect(factory.maximumActive).toBe(1);
  });

  it('enforces the hard deadline even while ledger progress remains active', async () => {
    const ledger = new TestLedger();
    ledger.advanceProgressOnRead = true;
    const factory = new TestFactory();

    const result = await createSupervisor(ledger, factory, {
      no_progress_timeout_ms: 1_000,
      hard_deadline_ms: 8,
      max_restarts: 0,
    }).run();

    expect(result).toMatchObject({ status: 'BLOCKED', state: 'EXHAUSTED', generation: 1 });
    expect(ledger.blockedReasons).toEqual([
      expect.stringContaining('hard deadline'),
    ]);
    expect(ledger.fenced[0]).toMatchObject({
      generation: 1,
      reason: expect.stringContaining('hard deadline'),
    });
  });

  it('returns BLOCKED with EXHAUSTED state when restart budget is spent', async () => {
    const ledger = new TestLedger();
    const factory = new TestFactory();
    const running = createSupervisor(ledger, factory, { max_restarts: 1 }).run();
    await waitFor(() => factory.handles.length === 1);
    factory.handles[0]!.exit({ code: 9, signal: null });
    await waitFor(() => factory.handles.length === 2);
    factory.handles[1]!.exit({ code: 10, signal: null });

    const result = await running;

    expect(result).toMatchObject({ status: 'BLOCKED', state: 'EXHAUSTED', generation: 2, restarts: 1 });
    expect(ledger.receipts.at(-1)).toMatchObject({ type: 'supervisor.exhausted', state: 'EXHAUSTED' });
  });

  it('treats the engine CLI BLOCKED exit code as a terminal factual blocker without restarting', async () => {
    const ledger = new TestLedger();
    const factory = new TestFactory();
    const running = createSupervisor(ledger, factory, { max_restarts: 2 }).run();
    await waitFor(() => factory.handles.length === 1);

    factory.handles[0]!.exit({ code: 3, signal: null });
    const result = await running;

    expect(result).toMatchObject({ status: 'BLOCKED', state: 'BLOCKED', restarts: 0 });
    expect(factory.handles).toHaveLength(1);
    expect(ledger.receipts.at(-1)).toMatchObject({ type: 'supervisor.terminal', state: 'BLOCKED' });
  });

  it('resumes after a prior engine generation by fencing and reconciling it first', async () => {
    const ledger = new TestLedger();
    ledger.generation = 4;
    const factory = new TestFactory();
    const running = createSupervisor(ledger, factory).run();
    await waitFor(() => factory.handles.length === 1);
    ledger.status = 'NOT_READY';

    const result = await running;

    expect(result).toMatchObject({ status: 'NOT_READY', state: 'NOT_READY', generation: 5 });
    expect(ledger.fenced[0]).toMatchObject({ generation: 4, reason: 'supervisor resume' });
    expect(ledger.terminatedGenerations).toEqual([4]);
    expect(ledger.reconciled).toEqual([4]);
  });

  it('does not resume when recovery cannot prove the previous engine tree is gone', async () => {
    const ledger = new TestLedger();
    ledger.generation = 3;
    ledger.reconciliationSafe = false;
    const factory = new TestFactory();

    const result = await createSupervisor(ledger, factory).run();

    expect(result).toMatchObject({
      status: 'BLOCKED',
      state: 'EXHAUSTED',
      generation: 3,
      restarts: 0,
    });
    expect(factory.handles).toHaveLength(0);
    expect(ledger.fenced).toEqual([{ generation: 3, reason: 'supervisor resume' }]);
  });
});
