import { randomUUID } from 'node:crypto';
import {
  NodeEngineProcessFactory,
  type NodeEngineProcessFactoryOptions,
} from './engineProcess.js';
import type {
  EngineExit,
  EngineProcessFactory,
  EngineProcessHandle,
  EngineProgress,
  EngineRunStatus,
  EngineSupervisorConfig,
  EngineSupervisorLedger,
  EngineSupervisorReceipt,
  EngineSupervisorResult,
  EngineSupervisorState,
} from './engineTypes.js';

export {
  NodeEngineProcessFactory,
  type NodeEngineProcessFactoryOptions,
};
export type {
  EngineExit,
  EngineProcessFactory,
  EngineProcessHandle,
  EngineProgress,
  EngineRunStatus,
  EngineSupervisorConfig,
  EngineSupervisorLedger,
  EngineSupervisorReceipt,
  EngineSupervisorResult,
  EngineSupervisorState,
} from './engineTypes.js';

interface Failure {
  reason: string;
  exit?: EngineExit;
}

function terminalState(status: EngineRunStatus): EngineSupervisorState {
  return status;
}

function exitReason(exit: EngineExit): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit ${exit.code ?? 'unknown'}`;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

/**
 * Deterministic parent supervisor for the RIJO orchestration engine.
 *
 * It owns no workflow decisions and no SQL. Runtime facts come from a real
 * process handle; durable facts and fencing go through EngineSupervisorLedger.
 * A replacement starts only after the prior process tree is proven gone,
 * fenced and reconciled.
 */
export class EngineSupervisor {
  private readonly ledger: EngineSupervisorLedger;
  private readonly processFactory: EngineProcessFactory;
  private readonly config: EngineSupervisorConfig;
  private readonly ownerId: string;

  constructor(options: {
    ledger: EngineSupervisorLedger;
    processFactory: EngineProcessFactory;
    config: EngineSupervisorConfig;
    owner_id?: string;
  }) {
    this.ledger = options.ledger;
    this.processFactory = options.processFactory;
    this.config = {
      poll_interval_ms: positive(options.config.poll_interval_ms, 'poll_interval_ms'),
      no_progress_timeout_ms: positive(options.config.no_progress_timeout_ms, 'no_progress_timeout_ms'),
      hard_deadline_ms: positive(options.config.hard_deadline_ms, 'hard_deadline_ms'),
      cancel_grace_ms: positive(options.config.cancel_grace_ms, 'cancel_grace_ms'),
      kill_grace_ms: positive(options.config.kill_grace_ms, 'kill_grace_ms'),
      max_restarts: Math.max(0, Math.trunc(options.config.max_restarts)),
    };
    this.ownerId = options.owner_id ?? `rijo-supervisor-${process.pid}-${randomUUID().slice(0, 12)}`;
  }

  private async receipt(
    type: EngineSupervisorReceipt['type'],
    state: EngineSupervisorState,
    generation: number,
    pid: number | null,
    reason?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    const receipt: EngineSupervisorReceipt = {
      receipt_id: randomUUID(),
      owner_id: this.ownerId,
      type,
      state,
      generation,
      supervisor_pid: process.pid,
      pid,
      process_group: process.platform === 'win32' ? null : pid,
      created_at: new Date().toISOString(),
    };
    if (reason !== undefined) receipt.reason = reason;
    if (data !== undefined) receipt.data = data;
    await this.ledger.appendSupervisorReceipt(receipt);
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private terminalResult(
    status: EngineRunStatus,
    generation: number,
    restarts: number,
    reason: string,
  ): EngineSupervisorResult {
    return { status, state: terminalState(status), generation, restarts, reason };
  }

  private async exhausted(
    generation: number,
    restarts: number,
    reason: string,
  ): Promise<EngineSupervisorResult> {
    await this.ledger.markRunBlocked?.(reason);
    return { status: 'BLOCKED', state: 'EXHAUSTED', generation, restarts, reason };
  }

  private async stopTree(
    handle: EngineProcessHandle,
    generation: number,
    reason: string,
  ): Promise<boolean> {
    if (!handle.isAlive()) return true;
    await this.receipt('engine.cancel_requested', 'CANCELLING', generation, handle.pid, reason);
    const graceful = await handle.terminate('term');
    if (graceful || !handle.isAlive()) {
      await this.receipt('engine.terminated', 'TERMINATING', generation, handle.pid, reason, {
        mode: 'term',
      });
      return true;
    }

    await this.wait(this.config.cancel_grace_ms);
    await this.receipt('engine.terminating', 'TERMINATING', generation, handle.pid, reason, {
      mode: 'kill',
    });
    const killed = await handle.terminate('kill');
    if (!killed && handle.isAlive()) await this.wait(this.config.kill_grace_ms);
    const dead = killed || !handle.isAlive();
    if (dead) {
      await this.receipt('engine.terminated', 'TERMINATING', generation, handle.pid, reason, {
        mode: 'kill',
      });
    }
    return dead;
  }

  private async fenceAndReconcile(generation: number, reason: string, pid: number | null): Promise<boolean> {
    await this.ledger.fenceEngineGeneration(generation, reason);
    await this.receipt('engine.fenced', 'TERMINATING', generation, pid, reason);
    const reconciliation = await this.ledger.reconcileEngineGeneration(generation);
    await this.receipt('engine.reconciled', 'TERMINATING', generation, pid, reason, {
      engine_tree_gone: reconciliation.engine_tree_gone,
      detail: reconciliation.detail ?? null,
    });
    return reconciliation.engine_tree_gone;
  }

  private async superviseGeneration(
    handle: EngineProcessHandle,
    generation: number,
  ): Promise<{ terminal?: EngineRunStatus; failure?: Failure }> {
    const startedAt = Date.now();
    let progress = await this.ledger.readProgress();
    let lastProgressAt = Date.now();
    let settledExit: EngineExit | undefined;
    void handle.result.then((exit) => {
      settledExit = exit;
    });

    for (;;) {
      const terminal = await this.ledger.readRunStatus();
      if (terminal) return { terminal };

      if (settledExit !== undefined || !handle.isAlive()) {
        const exit = settledExit ?? await handle.result;
        return { failure: { reason: exitReason(exit), exit } };
      }

      const now = Date.now();
      const nextProgress = await this.ledger.readProgress();
      if (nextProgress.sequence !== progress.sequence) {
        progress = nextProgress;
        lastProgressAt = now;
      }
      if (now - lastProgressAt >= this.config.no_progress_timeout_ms) {
        return { failure: { reason: `no ledger progress for ${now - lastProgressAt}ms` } };
      }
      if (now - startedAt >= this.config.hard_deadline_ms) {
        return { failure: { reason: `hard deadline ${this.config.hard_deadline_ms}ms exceeded` } };
      }

      await this.receipt('supervisor.heartbeat', 'RUNNING', generation, handle.pid, undefined, {
        progress_sequence: progress.sequence,
      });
      await this.wait(this.config.poll_interval_ms);
    }
  }

  async run(): Promise<EngineSupervisorResult> {
    const acquired = await this.ledger.acquireSupervisorLease(this.ownerId, process.pid);
    if (!acquired) {
      await this.receipt('supervisor.lock_denied', 'BLOCKED', 0, null, 'another supervisor owns the project');
      return this.terminalResult('BLOCKED', 0, 0, 'another supervisor owns the project');
    }

    let generation = 0;
    let restarts = 0;
    try {
      const existingTerminal = await this.ledger.readRunStatus();
      generation = await this.ledger.readLastEngineGeneration();
      await this.receipt('supervisor.started', 'STARTING', generation, null);
      if (existingTerminal) {
        if (generation > 0) {
          const termination = await this.ledger.terminateEngineGeneration?.(generation);
          if (termination && !termination.engine_tree_gone) {
            const reason =
              termination.detail ??
              'terminal run exists but prior engine tree could not be terminated';
            await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, null, reason);
            return await this.exhausted(generation, restarts, reason);
          }
          const terminalSafe = await this.fenceAndReconcile(
            generation,
            'terminal supervisor recovery',
            null,
          );
          if (!terminalSafe) {
            const reason = 'terminal run exists but prior engine tree could not be proven dead';
            await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, null, reason);
            return await this.exhausted(generation, restarts, reason);
          }
        }
        await this.receipt('supervisor.terminal', terminalState(existingTerminal), generation, null, 'run already terminal');
        return this.terminalResult(existingTerminal, generation, restarts, 'run already terminal');
      }

      if (generation > 0) {
        const termination = await this.ledger.terminateEngineGeneration?.(generation);
        if (termination && !termination.engine_tree_gone) {
          const reason =
            termination.detail ??
            'previous engine tree could not be terminated during resume';
          await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, null, reason);
          return await this.exhausted(generation, restarts, reason);
        }
        const resumeSafe = await this.fenceAndReconcile(generation, 'supervisor resume', null);
        if (!resumeSafe) {
          const reason = 'previous engine tree could not be proven dead during resume';
          await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, null, reason);
          return await this.exhausted(generation, restarts, reason);
        }
      }
      generation += 1;

      for (;;) {
        let handle: EngineProcessHandle;
        try {
          handle = await this.processFactory.start({ generation, owner_id: this.ownerId });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const reason = `engine spawn failed: ${message}`;
          await this.receipt('engine.suspect', 'SUSPECT', generation, null, reason);
          const reconciled = await this.fenceAndReconcile(generation, reason, null);
          if (!reconciled) {
            const unsafeReason = `${reason}; reconciliation could not prove the engine tree gone`;
            await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, null, unsafeReason);
            return await this.exhausted(generation, restarts, unsafeReason);
          }
          if (restarts >= this.config.max_restarts) {
            await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, null, reason);
            return await this.exhausted(generation, restarts, reason);
          }
          restarts += 1;
          generation += 1;
          await this.receipt('engine.restarting', 'RESTARTING', generation, null, reason, {
            restart: restarts,
            max_restarts: this.config.max_restarts,
          });
          continue;
        }
        await this.receipt('engine.started', 'RUNNING', generation, handle.pid);
        const outcome = await this.superviseGeneration(handle, generation);

        if (outcome.terminal) {
          const dead = await this.stopTree(handle, generation, `run reached ${outcome.terminal}`);
          if (!dead) {
            const reason = 'terminal run recorded but engine process tree could not be terminated';
            await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, handle.pid, reason);
            return await this.exhausted(generation, restarts, reason);
          }
          await this.receipt(
            'supervisor.terminal',
            terminalState(outcome.terminal),
            generation,
            handle.pid,
            `run reached ${outcome.terminal}`,
          );
          return this.terminalResult(outcome.terminal, generation, restarts, `run reached ${outcome.terminal}`);
        }

        const failure = outcome.failure ?? { reason: 'unknown engine failure' };
        // Exit 3 is RIJO's explicit BLOCKED contract (missing permission,
        // credential, conflicting requirements, destructive approval, quota,
        // etc.). It is not an engine crash and must not consume restart budget
        // or repeat a command that intentionally refused to proceed.
        if (failure.exit?.code === 3 && failure.exit.signal === null) {
          const dead = await this.stopTree(handle, generation, failure.reason);
          if (!dead) {
            const reason = `${failure.reason}; blocked engine tree still alive`;
            await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, handle.pid, reason);
            return await this.exhausted(generation, restarts, reason);
          }
          await this.receipt('supervisor.terminal', 'BLOCKED', generation, handle.pid, failure.reason);
          return this.terminalResult('BLOCKED', generation, restarts, failure.reason);
        }
        await this.receipt('engine.suspect', 'SUSPECT', generation, handle.pid, failure.reason);
        const dead = await this.stopTree(handle, generation, failure.reason);
        if (!dead) {
          const reason = `${failure.reason}; previous engine tree still alive`;
          await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, handle.pid, reason);
          return await this.exhausted(generation, restarts, reason);
        }

        const reconciled = await this.fenceAndReconcile(generation, failure.reason, handle.pid);
        if (!reconciled) {
          const reason = `${failure.reason}; reconciliation could not prove the engine tree gone`;
          await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, handle.pid, reason);
          return await this.exhausted(generation, restarts, reason);
        }
        if (restarts >= this.config.max_restarts) {
          await this.receipt('supervisor.exhausted', 'EXHAUSTED', generation, handle.pid, failure.reason);
          return await this.exhausted(generation, restarts, failure.reason);
        }

        restarts += 1;
        generation += 1;
        await this.receipt('engine.restarting', 'RESTARTING', generation, null, failure.reason, {
          restart: restarts,
          max_restarts: this.config.max_restarts,
        });
      }
    } finally {
      await this.ledger.releaseSupervisorLease(this.ownerId);
    }
  }
}
