import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.js';
import {
  buildDurableSnapshot,
  collectCanonicalArtifactHashes,
  readLatestSnapshot,
  writeDurableSnapshot,
  type WrittenSnapshot,
} from './snapshot.js';
import { DurableOutboxProjector } from './projector.js';
import { exportFinalizedEventSegment } from './segments.js';
import type {
  Checkpoint,
  DomainEvent,
  DurableRunStatus,
  Lease,
  RunRecord,
  StateStore,
  StoredDomainEvent,
} from './types.js';
import type { WorkflowProjectionPacket } from './workflowProjection.js';

export interface EnsureRunInput {
  plan?: string;
  plan_hash?: string;
  host: string;
  started_commit: string | null;
  next?: boolean;
  run_id?: string;
  created_at?: string;
}

export interface EnsureRunResult {
  run: RunRecord;
  created: boolean;
  resumed: boolean;
  plan_hash: string;
}

export interface ProgressEventInput {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload?: unknown;
  idempotency_key: string;
  created_at?: string;
}

export interface DurableCheckpointInput {
  reason: string;
  git_commit: string | null;
  tree_hash?: string | null;
  snapshot_hash?: string | null;
  idempotency_key: string;
  created_at?: string;
}

export interface TerminalizeInput {
  status: Extract<DurableRunStatus, 'READY' | 'NOT_READY' | 'BLOCKED'>;
  final_commit: string | null;
  terminal_reason: string;
  idempotency_key: string;
  created_at?: string;
}

export interface SnapshotBoundaryInput {
  checkpoint: Checkpoint;
  git_commit: string | null;
  artifact_hashes?: Record<string, string>;
  generated_at?: string;
  backup?: boolean;
}

export function computePlanHash(plan: string): string {
  return sha256(plan.replace(/\r\n/g, '\n').trimEnd());
}

export class DurablePlanMismatchError extends Error {
  readonly code = 'PLAN_MISMATCH';

  constructor(
    public readonly requestedPlanHash: string,
    public readonly existingPlanHash: string,
    message: string,
  ) {
    super(message);
    this.name = 'DurablePlanMismatchError';
  }
}

/**
 * Adapter-safe lifecycle facade. Workflows, the engine supervisor and CLI use
 * this contract and never import better-sqlite3 or execute SQL.
 */
export class DurableStateEngine {
  constructor(
    private readonly projectRoot: string,
    private readonly store: StateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async ensureRun(input: EnsureRunInput): Promise<EnsureRunResult> {
    const planHash =
      input.plan_hash ??
      (input.plan !== undefined ? computePlanHash(input.plan) : null);
    if (!planHash) throw new Error('beginOrResume requires plan or plan_hash');
    const active = await this.store.getActiveRun();
    const latestStore = this.store as StateStore & {
      getLatestRun?: () => Promise<RunRecord | null>;
    };
    const latest = active ?? await latestStore.getLatestRun?.() ?? null;
    const createdAt = input.created_at ?? this.now().toISOString();
    if (active) {
      if (input.next || active.plan_hash !== planHash) {
        throw new DurablePlanMismatchError(
          planHash,
          active.plan_hash,
          input.next
            ? `An active run (${active.id}) must reach a terminal checkpoint before --next.`
            : `The active run uses a different plan_hash; pass --next only for a new milestone.`,
        );
      }
      await this.recordEvent(active.id, {
        event_type: 'run.resumed',
        aggregate_type: 'run',
        aggregate_id: active.id,
        payload: { plan_hash: planHash, host: input.host },
        idempotency_key: `${active.id}:resume:${active.last_event_sequence}`,
        created_at: createdAt,
      });
      return {
        run: (await this.store.getRun(active.id))!,
        created: false,
        resumed: true,
        plan_hash: planHash,
      };
    }
    if (latest?.status === 'BLOCKED' && latest.plan_hash === planHash) {
      await this.recordEvent(latest.id, {
        event_type: 'run.resumed',
        aggregate_type: 'run',
        aggregate_id: latest.id,
        payload: { plan_hash: planHash, host: input.host, resumed_from: 'BLOCKED' },
        idempotency_key: `${latest.id}:resume-blocked:${latest.last_event_sequence}`,
        created_at: createdAt,
      });
      return {
        run: (await this.store.getRun(latest.id))!,
        created: false,
        resumed: true,
        plan_hash: planHash,
      };
    }

    const runId = input.run_id ?? `run-${randomUUID()}`;
    await this.recordEvent(runId, {
      event_type: 'run.created',
      aggregate_type: 'run',
      aggregate_id: runId,
      payload: {
        plan_hash: planHash,
        host: input.host,
        status: 'RUNNING',
        started_commit: input.started_commit,
      },
      idempotency_key: `${runId}:create`,
      created_at: createdAt,
    });
    return {
      run: (await this.store.getRun(runId))!,
      created: true,
      resumed: false,
      plan_hash: planHash,
    };
  }

  /** Workflow-port alias: create a new run or resume the matching active one. */
  async beginOrResume(input: EnsureRunInput): Promise<EnsureRunResult> {
    return this.ensureRun(input);
  }

  async recordProgress(runId: string, input: ProgressEventInput): Promise<StoredDomainEvent> {
    return this.recordEvent(runId, input);
  }

  async synchronizeWorkflowState(
    runId: string,
    projection: WorkflowProjectionPacket,
    idempotencyKey: string,
  ): Promise<StoredDomainEvent> {
    return this.recordEvent(runId, {
      event_type: 'state.synchronized',
      aggregate_type: 'run',
      aggregate_id: runId,
      payload: { projection },
      idempotency_key: idempotencyKey,
      created_at: this.now().toISOString(),
    });
  }

  recordProgressImmediate(runId: string, input: ProgressEventInput): StoredDomainEvent {
    const event: DomainEvent = {
      event_id: randomUUID(),
      run_id: runId,
      aggregate_type: input.aggregate_type,
      aggregate_id: input.aggregate_id,
      event_type: input.event_type,
      schema_version: 1,
      payload: input.payload ?? {},
      created_at: input.created_at ?? this.now().toISOString(),
      idempotency_key: input.idempotency_key,
    };
    const immediate = this.store as StateStore & {
      appendEventImmediate?: (candidate: DomainEvent) => StoredDomainEvent;
    };
    if (!immediate.appendEventImmediate) {
      throw new Error('Configured StateStore does not support immediate progress commits');
    }
    return immediate.appendEventImmediate(event);
  }

  async terminalize(runId: string, input: TerminalizeInput): Promise<RunRecord> {
    const eventType = {
      READY: 'run.ready',
      NOT_READY: 'run.not_ready',
      BLOCKED: 'run.blocked',
    }[input.status];
    await this.recordEvent(runId, {
      event_type: eventType,
      aggregate_type: 'run',
      aggregate_id: runId,
      payload: {
        final_commit: input.final_commit,
        terminal_reason: input.terminal_reason,
      },
      idempotency_key: input.idempotency_key,
      created_at: input.created_at,
    });
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Terminalized run ${runId} disappeared from the state store`);
    return run;
  }

  /** Workflow-port alias with explicit terminal vocabulary. */
  async markTerminal(runId: string, input: TerminalizeInput): Promise<RunRecord> {
    return this.terminalize(runId, input);
  }

  async claimTaskLease(taskId: string, lease: Lease): Promise<boolean> {
    return this.store.claimTask(taskId, lease);
  }

  async heartbeatAttempt(attemptId: string): Promise<void> {
    await this.store.heartbeatAttempt(attemptId);
  }

  async recordCheckpoint(
    runId: string,
    input: DurableCheckpointInput,
  ): Promise<{ event: StoredDomainEvent; checkpoint: Checkpoint }> {
    return this.store.transaction(async (tx) => {
      const createdAt = input.created_at ?? this.now().toISOString();
      const event = await tx.appendEvent({
        event_id: randomUUID(),
        run_id: runId,
        aggregate_type: 'run',
        aggregate_id: runId,
        event_type: 'checkpoint.created',
        schema_version: 1,
        payload: {
          reason: input.reason,
          commit: input.git_commit,
          tree_hash: input.tree_hash ?? null,
        },
        created_at: createdAt,
        idempotency_key: input.idempotency_key,
      });
      const checkpoint: Checkpoint = {
        id: `checkpoint-${runId}-${event.sequence}`,
        run_id: runId,
        event_sequence: event.sequence,
        kind: checkpointKind(input.reason),
        git_commit: input.git_commit,
        tree_hash: input.tree_hash ?? null,
        snapshot_hash: input.snapshot_hash ?? null,
        created_at: event.created_at,
        idempotency_key: input.idempotency_key,
      };
      await tx.saveCheckpoint(checkpoint);
      return { event, checkpoint };
    });
  }

  async fenceAttempt(
    runId: string,
    attemptId: string,
    generation: number,
    reason: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.store.transaction(async (tx) => {
      await tx.fenceAttempt(attemptId, reason);
      await tx.appendEvent({
        event_id: randomUUID(),
        run_id: runId,
        aggregate_type: 'attempt',
        aggregate_id: attemptId,
        event_type: 'attempt.fenced',
        schema_version: 1,
        payload: { attempt_id: attemptId, generation, reason },
        created_at: this.now().toISOString(),
        idempotency_key: idempotencyKey,
      });
    });
  }

  async checkpointBoundary(input: SnapshotBoundaryInput): Promise<WrittenSnapshot> {
    await this.store.saveCheckpoint(input.checkpoint);
    return this.createSnapshot({
      generated_at: input.generated_at,
      git_commit: input.git_commit,
      artifact_hashes: input.artifact_hashes,
      backup: input.backup,
    });
  }

  async createCheckpoint(input: SnapshotBoundaryInput): Promise<WrittenSnapshot> {
    return this.checkpointBoundary(input);
  }

  async createSnapshot(
    input: Omit<SnapshotBoundaryInput, 'checkpoint'>,
  ): Promise<WrittenSnapshot> {
    await this.flush();
    const generatedAt = input.generated_at ?? this.now().toISOString();
    const previousSequence = readLatestSnapshot(this.projectRoot)?.last_sequence ?? 0;
    await exportFinalizedEventSegment(this.projectRoot, this.store, previousSequence);
    const snapshot = await buildDurableSnapshot(this.store, {
      generated_at: generatedAt,
      git_commit: input.git_commit,
      artifact_hashes:
        input.artifact_hashes ?? collectCanonicalArtifactHashes(this.projectRoot),
    });
    const written = writeDurableSnapshot(this.projectRoot, snapshot);
    if (input.backup !== false) {
      const stamp = generatedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
      await this.store.createBackup(
        `${this.projectRoot}/.rijo/state/backups/${String(snapshot.last_sequence).padStart(6, '0')}-${stamp}.sqlite`,
      );
    }
    return written;
  }

  async flush(): Promise<number> {
    return new DurableOutboxProjector(this.projectRoot, this.store).flush();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  private async recordEvent(
    runId: string,
    input: ProgressEventInput,
  ): Promise<StoredDomainEvent> {
    return this.store.transaction((tx) =>
      tx.appendEvent({
        event_id: randomUUID(),
        run_id: runId,
        aggregate_type: input.aggregate_type,
        aggregate_id: input.aggregate_id,
        event_type: input.event_type,
        schema_version: 1,
        payload: input.payload ?? {},
        created_at: input.created_at ?? this.now().toISOString(),
        idempotency_key: input.idempotency_key,
      }),
    );
  }
}

function checkpointKind(
  reason: string,
): Checkpoint['kind'] {
  if (/terminal/i.test(reason)) return 'TERMINAL';
  if (/milestone/i.test(reason)) return 'MILESTONE';
  if (/phase/i.test(reason)) return 'PHASE';
  if (/migration/i.test(reason)) return 'MIGRATION';
  return 'TASK';
}

export function progressIdempotencyKey(
  runId: string,
  eventType: string,
  aggregateId: string,
  payload: unknown,
): string {
  return sha256(`${runId}\0${eventType}\0${aggregateId}\0${canonicalJson(payload)}`);
}
