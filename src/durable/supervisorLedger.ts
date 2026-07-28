import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.js';
import { recoverDurableState } from './factory.js';
import type { StateStore } from './types.js';
import {
  killProcessTree,
  processGroupAlive,
} from '../supervisor/killTree.js';

export type EngineRunStatus = 'READY' | 'NOT_READY' | 'BLOCKED';

export interface EngineProgress {
  sequence: number;
  observed_at: string;
}

export interface EngineSupervisorReceipt {
  receipt_id: string;
  owner_id: string;
  type: string;
  state: string;
  generation: number;
  supervisor_pid: number;
  pid: number | null;
  process_group: number | null;
  created_at: string;
  reason?: string;
  data?: Record<string, unknown>;
}

interface EngineLedgerStateStore extends StateStore {
  acquireNamedLock(name: string, ownerId: string, pid: number): Promise<boolean>;
  releaseNamedLock(name: string, ownerId: string): Promise<void>;
  readProgressMarker(): Promise<EngineProgress>;
  readLastProcessReceipts(processType: string): Promise<Array<Record<string, unknown>>>;
  appendProcessReceipt(receipt: Record<string, unknown>): Promise<void>;
  appendRecoveryReceipt(receipt: Record<string, unknown>): Promise<void>;
  fenceAllActiveAttempts(reason: string): Promise<void>;
}

/**
 * Structural implementation of supervisor/engineTypes.EngineSupervisorLedger.
 * It deliberately does not import the supervisor package.
 */
export class DurableEngineSupervisorLedger {
  constructor(
    private readonly store: EngineLedgerStateStore,
    private readonly mode: 'new' | 'run',
    private readonly openedSequence: number,
    private readonly openedRunId: string | null,
  ) {}

  async acquireSupervisorLease(ownerId: string, pid: number): Promise<boolean> {
    return this.store.acquireNamedLock('rijo-supervisor', ownerId, pid);
  }

  async releaseSupervisorLease(ownerId: string): Promise<void> {
    await this.store.releaseNamedLock('rijo-supervisor', ownerId);
  }

  async readRunStatus(): Promise<EngineRunStatus | null> {
    const run = await this.store.getLatestRun();
    if (
      run &&
      run.id === this.openedRunId &&
      run.last_event_sequence <= this.openedSequence &&
      (this.mode === 'new' || run.status === 'BLOCKED')
    ) {
      return null;
    }
    return run && ['READY', 'NOT_READY', 'BLOCKED'].includes(run.status)
      ? (run.status as EngineRunStatus)
      : null;
  }

  async readProgress(): Promise<EngineProgress> {
    return this.store.readProgressMarker();
  }

  async readLastEngineGeneration(): Promise<number> {
    const receipts = await this.store.readLastProcessReceipts('rijo-engine');
    return receipts.reduce((latest, receipt) => {
      const payload = parsePayload(receipt['payload']);
      const generation = Number(payload['generation'] ?? 0);
      return Math.max(latest, Number.isFinite(generation) ? generation : 0);
    }, 0);
  }

  async appendSupervisorReceipt(receipt: EngineSupervisorReceipt): Promise<void> {
    const run = await this.store.getLatestRun();
    await this.store.appendProcessReceipt({
      id: receipt.receipt_id,
      run_id: run?.id ?? null,
      process_type: receipt.type.startsWith('engine.') ? 'rijo-engine' : 'rijo-supervisor',
      pid: receipt.pid,
      process_group: receipt.process_group,
      action: receipt.type,
      payload: receipt,
      idempotency_key: receipt.receipt_id,
      created_at: receipt.created_at,
    });
  }

  async markRunBlocked(reason: string): Promise<void> {
    const run = await this.store.getActiveRun();
    if (!run) return;
    const createdAt = new Date().toISOString();
    await this.store.appendEvent({
      event_id: randomUUID(),
      run_id: run.id,
      aggregate_type: 'run',
      aggregate_id: run.id,
      event_type: 'run.blocked',
      schema_version: 1,
      payload: {
        final_commit: run.final_commit,
        terminal_reason: reason,
        source: 'engine-supervisor',
      },
      previous_event_hash: undefined,
      event_hash: undefined,
      created_at: createdAt,
      idempotency_key: sha256(`${run.id}\0supervisor-exhausted\0${reason}`),
    });
  }

  async terminateEngineGeneration(
    generation: number,
  ): Promise<{ engine_tree_gone: boolean; detail?: string }> {
    const identity = await this.engineIdentity(generation);
    if (!identity) {
      return { engine_tree_gone: true, detail: `engine generation ${generation} has no live identity` };
    }
    if (!processGroupAlive(identity.pid)) {
      return { engine_tree_gone: true, detail: `engine generation ${generation} was already absent` };
    }
    await killProcessTree(identity.pid, { mode: 'term' });
    if (!(await waitForTreeDeath(identity.pid, 1_000))) {
      await killProcessTree(identity.pid, { mode: 'kill' });
    }
    const gone = await waitForTreeDeath(identity.pid, 1_000);
    return {
      engine_tree_gone: gone,
      detail: gone
        ? `engine generation ${generation} tree terminated`
        : `engine generation ${generation} tree survived termination`,
    };
  }

  async fenceEngineGeneration(generation: number, reason: string): Promise<void> {
    await this.store.fenceAllActiveAttempts(
      `engine generation ${generation} fenced: ${reason}`,
    );
  }

  async reconcileEngineGeneration(
    generation: number,
  ): Promise<{ engine_tree_gone: boolean; detail?: string }> {
    const receipts = await this.store.readLastProcessReceipts('rijo-engine');
    // Fencing/reconciliation receipts are newer than engine.started but may
    // intentionally carry no PID. Select the newest receipt that actually
    // identifies the process tree; otherwise a newer null-PID receipt could
    // falsely "prove" a still-running orphan absent.
    const matching = receipts
      .filter((receipt) => Number(parsePayload(receipt['payload'])['generation'] ?? 0) === generation)
      .reverse()
      .find(
        (receipt) =>
          Number(receipt['process_group'] ?? 0) > 0 ||
          Number(receipt['pid'] ?? 0) > 0,
      );
    const pid = Number(matching?.['pid'] ?? 0);
    const processGroup = Number(matching?.['process_group'] ?? 0);
    const alive = processGroup > 0 && process.platform !== 'win32'
      ? processAlive(-processGroup)
      : pid > 0
        ? processAlive(pid)
        : false;
    const detail = alive
      ? `engine generation ${generation} process tree is still alive`
      : `engine generation ${generation} process tree is absent`;
    const run = await this.store.getLatestRun();
    await this.store.appendRecoveryReceipt({
      id: randomUUID(),
      run_id: run?.id ?? null,
      recovery_type: 'engine_generation',
      source_hash: matching ? sha256(canonicalJson(matching)) : null,
      result_hash: sha256(canonicalJson({ generation, engine_tree_gone: !alive, detail })),
      payload: { generation, engine_tree_gone: !alive, detail },
      idempotency_key: sha256(`engine-reconcile\0${generation}\0${detail}`),
      created_at: new Date().toISOString(),
    });
    return { engine_tree_gone: !alive, detail };
  }

  private async engineIdentity(
    generation: number,
  ): Promise<{ pid: number } | null> {
    const receipts = await this.store.readLastProcessReceipts('rijo-engine');
    const matching = receipts
      .filter((receipt) => Number(parsePayload(receipt['payload'])['generation'] ?? 0) === generation)
      .reverse()
      .find(
        (receipt) =>
          Number(receipt['process_group'] ?? 0) > 0 ||
          Number(receipt['pid'] ?? 0) > 0,
      );
    const pid = Number(matching?.['process_group'] ?? matching?.['pid'] ?? 0);
    return pid > 0 ? { pid } : null;
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

export async function openEngineSupervisorLedger(
  projectRoot: string,
  options: { mode?: 'new' | 'run'; stateStore?: 'auto' | 'sqlite' | 'file' } = {},
): Promise<DurableEngineSupervisorLedger> {
  const recovery = await recoverDurableState({
    projectRoot,
    acquireWriterLock: false,
    stateStore: options.stateStore,
  });
  const store = recovery.store as EngineLedgerStateStore;
  const opened = await store.getLatestRun();
  const openedProgress = await store.readProgressMarker();
  return new DurableEngineSupervisorLedger(
    store,
    options.mode ?? 'run',
    openedProgress.sequence,
    opened?.id ?? null,
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForTreeDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
