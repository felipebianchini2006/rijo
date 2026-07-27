import type { ProgressUpdate } from '../core/progress.js';
import type { StatusSnapshot } from '../core/schemas/index.js';
import {
  computePlanHash,
  DurablePlanMismatchError,
  DurableStateEngine,
  progressIdempotencyKey,
} from './engine.js';
import type { DurableRecoveryResult } from './recovery.js';
import type { RunRecord } from './types.js';
import { collectWorkflowProjection } from './workflowProjection.js';

export interface DurableRunBinding {
  runId: string;
  disposition: 'created' | 'resumed' | 'plan_mismatch';
  planHash: string | null;
  existingPlanHash?: string | null;
}

export interface DurableProgressRecord {
  runId: string;
  type: string;
  ts: string;
  update: ProgressUpdate;
  data: Record<string, unknown>;
  snapshot: StatusSnapshot;
}

/**
 * Structural adapter for workflows/shared.ts. It intentionally does not import
 * that module, keeping the durable layer below workflows in the dependency graph.
 */
export class DurableWorkflowEngine {
  private run: RunRecord | null = null;
  private lastCheckpointCommit: string | null = null;

  constructor(
    private readonly projectRoot: string,
    private readonly engine: DurableStateEngine,
    private readonly recoveryResult: DurableRecoveryResult,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    await this.engine.initialize();
  }

  async recover(): Promise<void> {
    // openDurableWorkflowEngine completed recovery before exposing this port.
  }

  async beginOrResumeRun(input: {
    requestedRunId: string;
    plan?: string;
    planHash?: string;
    next?: boolean;
    host?: string;
    startedCommit?: string | null;
  }): Promise<DurableRunBinding> {
    const active = await this.recoveryResult.store.getActiveRun();
    const latest = await this.recoveryResult.store.getLatestRun();
    const requestedPlanHash =
      input.planHash ??
      (input.plan !== undefined
        ? computePlanHash(input.plan)
        : active?.plan_hash ??
          (latest?.status === 'BLOCKED' ? latest.plan_hash : null));
    if (!requestedPlanHash) {
      return {
        runId: input.requestedRunId,
        disposition: 'plan_mismatch',
        planHash: null,
        existingPlanHash: null,
      };
    }
    if (
      !active &&
      latest &&
      latest.status !== 'BLOCKED' &&
      input.plan !== undefined &&
      !input.next
    ) {
      return {
        runId: latest.id,
        disposition: 'plan_mismatch',
        planHash: requestedPlanHash,
        existingPlanHash: latest.plan_hash,
      };
    }
    try {
      const result = await this.engine.beginOrResume({
        plan: input.plan,
        plan_hash: requestedPlanHash,
        host: input.host ?? 'unknown',
        started_commit: input.startedCommit ?? null,
        next: input.next,
        run_id: input.requestedRunId,
      });
      this.run = result.run;
      return {
        runId: result.run.id,
        disposition: result.created ? 'created' : 'resumed',
        planHash: result.plan_hash,
      };
    } catch (error) {
      if (!(error instanceof DurablePlanMismatchError)) throw error;
      return {
        runId: active?.id ?? input.requestedRunId,
        disposition: 'plan_mismatch',
        planHash: error.requestedPlanHash,
        existingPlanHash: error.existingPlanHash,
      };
    }
  }

  recordProgress(record: DurableProgressRecord): void {
    const runId = this.run?.id ?? record.runId;
    const aggregateId =
      record.snapshot.task?.id ??
      record.snapshot.phase?.id ??
      record.snapshot.milestone?.id ??
      runId;
    const eventType = domainEventType(record.type);
    const payload = {
      source_event_type: record.type,
      update: record.update,
      data: record.data,
      snapshot: record.snapshot,
      observed_at: record.ts,
    };
    this.engine.recordProgressImmediate(runId, {
      event_type: eventType,
      aggregate_type: record.snapshot.task
        ? 'task'
        : record.snapshot.phase
          ? 'phase'
          : record.snapshot.milestone
            ? 'milestone'
            : 'run',
      aggregate_id: aggregateId,
      payload,
      idempotency_key: progressIdempotencyKey(
        runId,
        eventType,
        aggregateId,
        { ...payload, observed_at: record.ts },
      ),
      created_at: record.ts,
    });
  }

  async createCheckpoint(input: { reason: string; commit?: string | null }): Promise<void> {
    const run = await this.currentRun();
    const projection = collectWorkflowProjection(this.projectRoot);
    await this.engine.synchronizeWorkflowState(
      run.id,
      projection,
      progressIdempotencyKey(
        run.id,
        'state.synchronized',
        run.id,
        { reason: input.reason, commit: input.commit ?? null, projection },
      ),
    );
    const idempotencyKey = progressIdempotencyKey(
      run.id,
      'checkpoint.created',
      run.id,
      { reason: input.reason, commit: input.commit ?? null },
    );
    await this.engine.recordCheckpoint(run.id, {
      reason: input.reason,
      git_commit: input.commit ?? null,
      idempotency_key: idempotencyKey,
      created_at: this.now().toISOString(),
    });
    this.lastCheckpointCommit = input.commit ?? null;
  }

  async createSnapshot(_input: { reason: string }): Promise<void> {
    const run = await this.currentRun();
    await this.engine.createSnapshot({
      git_commit:
        this.lastCheckpointCommit ??
        run.final_commit ??
        run.started_commit,
      generated_at: this.now().toISOString(),
      backup: true,
    });
  }

  async markTerminal(input: {
    status: 'READY' | 'NOT_READY' | 'BLOCKED';
    reason: string;
    commit?: string | null;
  }): Promise<void> {
    const run = await this.currentRun();
    this.run = await this.engine.markTerminal(run.id, {
      status: input.status,
      final_commit: input.commit ?? run.final_commit,
      terminal_reason: input.reason,
      idempotency_key: `${run.id}:terminal:${input.status}`,
      created_at: this.now().toISOString(),
    });
  }

  async flush(): Promise<void> {
    await this.engine.flush();
  }

  async close(): Promise<void> {
    await this.engine.close();
  }

  private async currentRun(): Promise<RunRecord> {
    const run = this.run ?? await this.recoveryResult.store.getActiveRun();
    if (!run) throw new Error('Durable workflow has no bound run');
    this.run = run;
    return run;
  }
}

function domainEventType(source: string): string {
  return {
    'map.preflight': 'map.started',
    'map.done': 'map.completed',
    'run.plan_approved': 'phase.planned',
    'run.task_start': 'task.dispatched',
    'run.task_done': 'task.implemented',
    'run.phase_done': 'phase.completed',
    'check.start': 'check.started',
    'check.done': 'check.completed',
  }[source] ?? source;
}
