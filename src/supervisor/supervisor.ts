import { randomUUID } from 'node:crypto';
import { sha256 } from '../core/fsx.js';
import { RijoPaths } from '../core/paths.js';
import { TaskRecordSchema, type SupervisorConfig, type ModelRole, type TaskRecord } from '../core/schemas/index.js';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { HostAgentController, HostAttemptHandle } from '../hosts/controller.js';
import { SystemClock, type Clock, type TimerHandle } from './clock.js';
import { TaskStore } from './store.js';

/** A fresh, isolated attempt supplied by the caller for each generation. */
export interface PreparedAttempt {
  /** A brand-new task with a brand-new workspace. NEVER the previous attempt's task/workspace. */
  task: AgentTask;
  /** Release the attempt's resources (its workspace). Called when the attempt is abandoned. */
  dispose: () => void | Promise<void>;
}

export interface SuperviseOptions {
  /** Role override for timeout selection. Defaults to task.role. */
  role?: ModelRole;
  /**
   * Called for every replacement generation (>1). Must return a task with a
   * FRESH workspace. The supervisor appends only a short factual note about the
   * previous failure — never the previous scratchpad or patch.
   */
  prepareAttempt?: (generation: number, previousFailure: string) => PreparedAttempt | Promise<PreparedAttempt>;
  /** Receives a progress emitter bound to this task; call it whenever the attempt makes progress. */
  onProgress?: (emitProgress: () => void) => void;
  /** External kill switch. Aborting cancels the active attempt and stops (no replacement). */
  signal?: AbortSignal;
  /** Expert profiles recorded on the task record. */
  expertProfiles?: string[];
}

interface AttemptIdentity {
  attempt_id: string;
  generation: number;
  lease_id: string;
}

type AttemptOutcome =
  | { kind: 'succeeded'; result: AgentResult; record: TaskRecord }
  | { kind: 'failed'; reason: string; record: TaskRecord }
  | { kind: 'cancelled'; reason: string; record: TaskRecord };

interface ActiveTask {
  logicalId: string;
  record: TaskRecord;
  lastProgressAt: number;
  abort?: AbortController;
  /** Set by the running attempt: evaluate a delivered result (host or out-of-band). */
  onResultEval?: (result: AgentResult, source: 'host' | 'external') => void;
  /** Set by the running attempt: begin cancellation (used by dispose/abort). */
  requestCancel?: (reason: string) => void;
  disposing: boolean;
}

type RaceOutcome<T> = { outcome: 'value'; value: T } | { outcome: 'timeout' } | { outcome: 'error'; error: unknown };

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Deterministic supervisor. Its single guarantee: no agent attempt can block a
 * workflow indefinitely. Liveness comes only from the host controller (runtime
 * facts), never from model output; every wait is bounded by the injected Clock
 * and an AbortSignal; only the current generation holding the current, unrevoked
 * lease can produce an applicable result; budgets are configurable with safe
 * defaults; and an exhausted task ends cleanly with an actionable BLOCKED result
 * rather than looping forever.
 */
export class Supervisor {
  private readonly controller: HostAgentController;
  private readonly config: SupervisorConfig;
  private readonly clock: Clock;
  private readonly store: TaskStore;
  private readonly active = new Map<string, ActiveTask>();
  private disposed = false;

  constructor(opts: { controller: HostAgentController; config: SupervisorConfig; paths: RijoPaths; clock?: Clock }) {
    this.controller = opts.controller;
    this.config = opts.config;
    this.clock = opts.clock ?? new SystemClock();
    this.store = new TaskStore(opts.paths);
  }

  /** Read-only access to the durable store (events/records) for callers and recovery. */
  get taskStore(): TaskStore {
    return this.store;
  }

  private toIso(ms = this.clock.now()): string {
    return new Date(ms).toISOString();
  }

  private mkIdentity(logicalId: string, generation: number): AttemptIdentity {
    const token = randomUUID().slice(0, 8);
    return {
      attempt_id: `${logicalId}#g${generation}-${token}`,
      generation,
      lease_id: `lease-${logicalId}-g${generation}-${token}`,
    };
  }

  private backoffFor(replacementIndex: number): number {
    const arr = this.config.replacement_backoff_ms;
    if (arr.length === 0) return 0;
    const idx = Math.min(replacementIndex, arr.length - 1);
    return arr[idx] ?? 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.clock.setTimer(() => resolve(), Math.max(0, ms));
    });
  }

  /** Bound a promise by a clock deadline. Never rejects; classifies the outcome. */
  private raceDeadline<T>(promise: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
    return new Promise<RaceOutcome<T>>((resolve) => {
      let done = false;
      const timer = this.clock.setTimer(() => {
        if (done) return;
        done = true;
        resolve({ outcome: 'timeout' });
      }, ms);
      promise.then(
        (value) => {
          if (done) return;
          done = true;
          this.clock.clearTimer(timer);
          resolve({ outcome: 'value', value });
        },
        (error) => {
          if (done) return;
          done = true;
          this.clock.clearTimer(timer);
          resolve({ outcome: 'error', error });
        },
      );
    });
  }

  /** Signal that the given logical task made progress. Runtime fact, never model output. */
  notifyProgress(logicalTaskId: string): void {
    const st = this.active.get(logicalTaskId);
    if (!st) return;
    st.lastProgressAt = this.clock.now();
    this.store.emit(logicalTaskId, 'progress', { at: this.toIso(st.lastProgressAt) });
  }

  /**
   * Ingest a result delivered out of band (duplicate delivery, recovery replay,
   * stale-lease echo). Accepted only if it matches the current active attempt;
   * otherwise recorded as LATE_OR_STALE_RESULT and discarded.
   */
  ingestResult(logicalTaskId: string, result: AgentResult): 'accepted' | 'discarded' {
    const st = this.active.get(logicalTaskId);
    if (st && st.onResultEval) {
      const before = st.record.state;
      // The active attempt's evaluator settles it if the result is valid;
      // otherwise it records the LATE_OR_STALE_RESULT event itself.
      st.onResultEval(result, 'external');
      return st.record.state === 'SUCCEEDED' && before !== 'SUCCEEDED' ? 'accepted' : 'discarded';
    }
    // No active attempt: evaluate against the durable record (always terminal/stale).
    const cur = this.store.read(logicalTaskId);
    const reason = cur
      ? `state ${cur.state} does not admit completion`
      : 'no record for logical task';
    this.store.emit(logicalTaskId, 'late_or_stale_result', {
      disposition: 'LATE_OR_STALE_RESULT',
      reason,
      result_attempt_id: result.attempt_id,
      result_generation: result.generation,
      result_lease_id: result.lease_id,
      expected_attempt_id: cur?.attempt_id ?? null,
      expected_generation: cur?.generation ?? null,
      expected_lease_id: cur?.lease_id ?? null,
    });
    return 'discarded';
  }

  /** Stop everything: cancel active attempts (CANCELLING→CANCELLED) with no orphan timers. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const st of [...this.active.values()]) {
      st.disposing = true;
      st.abort?.abort();
      st.requestCancel?.('supervisor disposed');
    }
  }

  private buildAttemptTask(task: AgentTask, id: AttemptIdentity, idempotencyKey: string): AgentTask {
    return {
      ...task,
      attempt: {
        logical_task_id: task.id,
        attempt_id: id.attempt_id,
        generation: id.generation,
        lease_id: id.lease_id,
        idempotency_key: idempotencyKey,
        canonical_baseline_hash: task.canonical_baseline ?? null,
        workspace_id: task.workspace?.id ?? null,
      },
    };
  }

  private withFailureNote(task: AgentTask, generation: number, previousFailure: string): AgentTask {
    const reason = previousFailure.slice(0, 200);
    const note = `[supervisor] previous attempt ${generation - 1} failed: ${reason}`;
    return { ...task, notes: task.notes ? `${task.notes}\n${note}` : note };
  }

  private blockedResult(
    record: TaskRecord,
    failures: string[],
    replacements: number,
    cause: string,
  ): AgentResult {
    const recent = failures.slice(-3);
    return {
      task_id: record.logical_task_id,
      ok: false,
      summary: `BLOCKED: task ${record.logical_task_id} exhausted after ${replacements} replacement(s) (${cause}). Last errors: ${
        recent.join(' | ') || 'none recorded'
      }`,
      files_written: [],
      payload: {
        diagnostic: {
          logical_task_id: record.logical_task_id,
          final_state: 'EXHAUSTED',
          cause,
          attempts: replacements + 1,
          replacements,
          last_errors: failures.slice(-5),
        },
      },
      scope_requests: [],
      attempt_id: record.attempt_id,
      generation: record.generation,
      lease_id: record.lease_id,
    };
  }

  /**
   * Supervise one logical task to a terminal outcome. Always resolves with an
   * AgentResult (never throws, never hangs): a matched successful result, or an
   * ok:false result carrying a BLOCKED/CANCELLED diagnostic.
   */
  async superviseTask(task: AgentTask, opts: SuperviseOptions = {}): Promise<AgentResult> {
    const role: ModelRole = opts.role ?? task.role;
    const logicalId = task.id;
    const startedWall = this.clock.now();
    const idempotencyKey = sha256(logicalId).slice(0, 32);

    let generation = 1;
    let identity = this.mkIdentity(logicalId, generation);

    const initial = TaskRecordSchema.parse({
      logical_task_id: logicalId,
      attempt_id: identity.attempt_id,
      generation,
      lease_id: identity.lease_id,
      idempotency_key: idempotencyKey,
      role,
      expert_profiles: opts.expertProfiles ?? task.expert_profiles ?? [],
      host: this.controller.host,
      workspace_id: task.workspace?.id ?? null,
      workspace_path: task.workspace?.root ?? null,
      canonical_baseline_hash: task.canonical_baseline ?? null,
      state: 'QUEUED',
      created_at: this.toIso(startedWall),
    });

    const st: ActiveTask = {
      logicalId,
      record: this.store.create(initial),
      lastProgressAt: startedWall,
      disposing: false,
    };
    this.active.set(logicalId, st);
    opts.onProgress?.(() => this.notifyProgress(logicalId));

    // Keep the Node event loop alive for the ENTIRE duration of this supervised
    // task. Between attempts — notably the replacement backoff — the failed host
    // child has already exited and every Clock timer is deliberately unref'd, so
    // without one explicit ref'd handle the process would drain its loop and
    // exit 0 mid-supervision, silently abandoning an in-flight turnkey workflow
    // (phase left IN_PROGRESS, no result). This handle is ref'd on purpose and
    // cleared the instant the task reaches a terminal outcome (finally below),
    // so a settled supervisor never keeps the process alive.
    const keepAlive: NodeJS.Timeout = setInterval(() => {}, 60_000);

    const failures: string[] = [];
    let currentTask = task;
    let currentDispose: (() => void | Promise<void>) | null = null;

    const disposeCurrentAttemptResources = async (): Promise<void> => {
      if (currentDispose) {
        try {
          await currentDispose();
        } catch {
          /* best-effort resource release */
        }
        currentDispose = null;
      }
    };

    try {
      for (;;) {
        // STARTING (from QUEUED for gen 1, from REPLACING for replacements).
        const softDeadline = this.clock.now() + this.config.no_progress_timeout_ms[role];
        const hardDeadline = this.clock.now() + this.config.hard_timeout_ms[role];
        st.record = this.store.transition(st.record, 'STARTING', {
          attempt_id: identity.attempt_id,
          generation,
          lease_id: identity.lease_id,
          started_at: this.toIso(),
          soft_deadline_at: this.toIso(softDeadline),
          hard_deadline_at: this.toIso(hardDeadline),
          workspace_id: currentTask.workspace?.id ?? null,
          workspace_path: currentTask.workspace?.root ?? null,
        });

        const attemptTask = this.buildAttemptTask(currentTask, identity, idempotencyKey);
        const abort = new AbortController();
        st.abort = abort;
        if (opts.signal) {
          if (opts.signal.aborted) abort.abort();
          else opts.signal.addEventListener('abort', () => abort.abort(), { once: true });
        }

        let handle: HostAttemptHandle | null = null;
        try {
          handle = await this.controller.start(
            { task: attemptTask, hard_deadline_at: this.toIso(hardDeadline) },
            abort.signal,
          );
        } catch (err) {
          const reason = `start failed: ${errMsg(err)}`;
          failures.push(reason);
          st.record = this.store.transition(st.record, 'FAILED', { finished_at: this.toIso(), last_error: reason }, { reason });
        }

        if (handle) {
          st.record = this.store.transition(st.record, 'RUNNING', {
            host_session_id: handle.session_id ?? null,
            host_thread_id: handle.thread_id ?? null,
            host_turn_id: handle.turn_id ?? null,
            host_process_id: handle.process_id ?? null,
            last_heartbeat_at: this.toIso(),
          });
          st.lastProgressAt = this.clock.now();

          const outcome = await this.runAttempt(st, handle, role);
          st.record = outcome.record;

          if (outcome.kind === 'succeeded') {
            await this.safeDispose(handle);
            this.active.delete(logicalId);
            return outcome.result;
          }
          await this.safeDispose(handle);
          failures.push(outcome.reason);
        }

        // External stop wins over replacement.
        if (this.disposed || st.disposing || opts.signal?.aborted) {
          await disposeCurrentAttemptResources();
          this.active.delete(logicalId);
          const reason = this.disposed || st.disposing ? 'supervisor disposed' : 'external abort';
          return {
            task_id: logicalId,
            ok: false,
            summary: `CANCELLED: ${reason} for ${logicalId}`,
            files_written: [],
            payload: { diagnostic: { logical_task_id: logicalId, final_state: st.record.state, cause: reason } },
            scope_requests: [],
            attempt_id: st.record.attempt_id,
            generation: st.record.generation,
            lease_id: st.record.lease_id,
          };
        }

        // Budget check.
        const elapsed = this.clock.now() - startedWall;
        const replacementsDone = st.record.replacement_count;
        const overCount = replacementsDone >= this.config.max_replacements_per_task;
        const overTime = elapsed >= this.config.max_total_task_elapsed_ms;
        if (overCount || overTime) {
          st.record = this.store.transition(st.record, 'EXHAUSTED', { finished_at: this.toIso() });
          await disposeCurrentAttemptResources();
          this.active.delete(logicalId);
          return this.blockedResult(st.record, failures, replacementsDone, overTime ? 'time budget' : 'replacement budget');
        }

        // REPLACING → backoff → fresh attempt.
        const backoff = this.backoffFor(replacementsDone);
        st.record = this.store.transition(st.record, 'REPLACING', { replacement_count: replacementsDone + 1 });
        await disposeCurrentAttemptResources();
        if (backoff > 0) await this.delay(backoff);

        generation += 1;
        identity = this.mkIdentity(logicalId, generation);
        const prevReason = failures[failures.length - 1] ?? 'unknown';
        if (opts.prepareAttempt) {
          const prepared = await opts.prepareAttempt(generation, prevReason);
          currentTask = this.withFailureNote(prepared.task, generation, prevReason);
          currentDispose = prepared.dispose;
        } else {
          currentTask = this.withFailureNote(task, generation, prevReason);
          currentDispose = null;
        }
      }
    } catch (err) {
      this.store.emit(logicalId, 'supervisor_error', { error: errMsg(err) });
      await disposeCurrentAttemptResources();
      this.active.delete(logicalId);
      const cur = this.store.read(logicalId);
      return {
        task_id: logicalId,
        ok: false,
        summary: `BLOCKED: supervisor internal error: ${errMsg(err)}`,
        files_written: [],
        payload: { diagnostic: { logical_task_id: logicalId, error: errMsg(err), final_state: cur?.state ?? 'unknown' } },
        scope_requests: [],
        attempt_id: cur?.attempt_id ?? null,
        generation: cur?.generation ?? null,
        lease_id: cur?.lease_id ?? null,
      };
    } finally {
      clearInterval(keepAlive);
    }
  }

  private async safeDispose(handle: HostAttemptHandle): Promise<void> {
    try {
      await this.controller.dispose(handle);
    } catch {
      /* best-effort */
    }
  }

  /**
   * Monitor one attempt with bounded pollers until it produces a matching
   * result, is cancelled, or fails. All timers are cleared exactly once on
   * settle so no orphan timer survives the attempt.
   */
  private runAttempt(st: ActiveTask, handle: HostAttemptHandle, role: ModelRole): Promise<AttemptOutcome> {
    return new Promise<AttemptOutcome>((resolve) => {
      let settled = false;
      let cancelling = false;
      let lastAliveAt = this.clock.now();
      const timers: TimerHandle[] = [];
      const graceMs = this.config.heartbeat_grace_ms;
      const noProgressMs = this.config.no_progress_timeout_ms[role];
      const hardMs = this.config.hard_timeout_ms[role];

      const clearAll = (): void => {
        for (const t of timers) this.clock.clearTimer(t);
        timers.length = 0;
      };
      const set = (r: TaskRecord): TaskRecord => {
        st.record = r;
        return r;
      };
      const finish = (o: AttemptOutcome): void => {
        if (settled) return;
        settled = true;
        clearAll();
        resolve(o);
      };

      // Result evaluation (used by both the host result promise and out-of-band ingestion).
      const evaluate = (r: AgentResult): { accept: boolean; ok: boolean; reason: string } => {
        const cur = st.record;
        const matches = r.attempt_id === cur.attempt_id && r.generation === cur.generation && r.lease_id === cur.lease_id;
        const admits = cur.state === 'RUNNING' || cur.state === 'SUSPECT';
        const notRevoked = r.lease_id != null && !cur.revoked_leases.includes(r.lease_id);
        if (!matches) return { accept: false, ok: r.ok, reason: 'identity mismatch (stale generation/lease/attempt)' };
        if (!notRevoked) return { accept: false, ok: r.ok, reason: 'lease revoked (fenced)' };
        if (!admits) return { accept: false, ok: r.ok, reason: `state ${cur.state} does not admit completion` };
        return { accept: true, ok: r.ok, reason: 'accepted' };
      };

      st.onResultEval = (r: AgentResult): void => {
        const cur = st.record;
        const verdict = evaluate(r);
        if (verdict.accept && !settled) {
          if (verdict.ok) {
            set(this.store.transition(cur, 'SUCCEEDED', { finished_at: this.toIso() }));
            finish({ kind: 'succeeded', result: r, record: st.record });
          } else {
            const reason = `agent reported failure: ${r.summary}`;
            set(this.store.transition(cur, 'FAILED', { finished_at: this.toIso(), last_error: r.summary }));
            finish({ kind: 'failed', reason, record: st.record });
          }
          return;
        }
        this.store.emit(cur.logical_task_id, 'late_or_stale_result', {
          disposition: 'LATE_OR_STALE_RESULT',
          reason: verdict.reason,
          result_attempt_id: r.attempt_id,
          result_generation: r.generation,
          result_lease_id: r.lease_id,
          expected_attempt_id: cur.attempt_id,
          expected_generation: cur.generation,
          expected_lease_id: cur.lease_id,
        });
      };

      // Cancellation ladder: request → (grace) → forceTerminate → (grace) → fence.
      const beginCancel = async (reason: string): Promise<void> => {
        if (cancelling || settled) return;
        cancelling = true;
        if (st.record.state === 'RUNNING' || st.record.state === 'SUSPECT') {
          set(this.store.transition(st.record, 'CANCELLING', { cancel_requested_at: this.toIso(), last_error: reason }, { reason }));
        }
        // The graceful ladder drives termination through requestCancel /
        // forceTerminate. The AbortSignal is NOT triggered here: it is the
        // external/dispose hard-stop, and firing it now would let a controller
        // that maps abort→SIGKILL bypass the graceful SIGTERM step.

        const req = await this.raceDeadline(this.controller.requestCancel(handle, reason), this.config.cancel_grace_ms);
        let acknowledged = req.outcome === 'value' && req.value.acknowledged;

        if (!acknowledged && this.controller.forceTerminate) {
          const term = await this.raceDeadline(
            this.controller.forceTerminate(handle, reason),
            this.config.hard_kill_grace_ms,
          );
          acknowledged = term.outcome === 'value' && term.value.terminated;
          if (acknowledged && term.outcome === 'value') {
            this.store.emit(st.record.logical_task_id, 'force_terminated', { method: term.value.method, reason });
          }
        }

        if (!acknowledged) {
          // FENCING: no confirmed termination. Revoke the lease, invalidate the
          // workspace, record termination as not_supported. Nothing this attempt
          // returns can ever be applied.
          const revoked = [...st.record.revoked_leases, st.record.lease_id];
          set(
            this.store.patch(
              st.record,
              { revoked_leases: revoked, workspace_id: null },
              'fenced',
              {
                lease_id: st.record.lease_id,
                reason,
                termination: 'not_supported',
                workspace_invalidated: true,
              },
            ),
          );
        }

        if (settled) return;
        set(this.store.transition(st.record, 'CANCELLED', { cancel_acknowledged_at: this.toIso(), finished_at: this.toIso() }));
        finish({ kind: 'cancelled', reason, record: st.record });
      };
      st.requestCancel = (reason: string) => void beginCancel(reason);

      // Re-arming liveness + progress poll.
      const scheduleHeartbeat = (): void => {
        if (settled || cancelling) return;
        timers.push(this.clock.setTimer(() => void heartbeatTick(), this.config.heartbeat_interval_ms));
      };
      const heartbeatTick = async (): Promise<void> => {
        if (settled || cancelling) return;
        let alive = false;
        try {
          const live = await this.controller.heartbeat(handle);
          alive = live.alive;
        } catch {
          alive = false;
        }
        if (settled || cancelling) return;
        const now = this.clock.now();
        if (alive) {
          lastAliveAt = now;
          if (st.record.state === 'SUSPECT') set(this.store.transition(st.record, 'RUNNING', {}, { recovered: true }));
        }
        const heartbeatLost = !alive && now - lastAliveAt > graceMs;
        const progressStalled = now - st.lastProgressAt > noProgressMs;
        if (heartbeatLost || progressStalled) {
          if (st.record.state === 'RUNNING') {
            set(
              this.store.transition(st.record, 'SUSPECT', {}, { reason: heartbeatLost ? 'heartbeat lost' : 'no progress' }),
            );
          }
          // Short confirmation probe. A 'completed' host means the result is
          // imminent — give it one more cycle instead of cancelling.
          const probe = await this.raceDeadline(this.controller.query(handle), Math.max(1, Math.floor(graceMs / 3)));
          if (settled || cancelling) return;
          const kind = probe.outcome === 'value' ? probe.value.kind : 'unknown';
          if (kind === 'completed') {
            scheduleHeartbeat();
            return;
          }
          void beginCancel(heartbeatLost ? 'heartbeat lost beyond grace' : 'no progress beyond timeout');
          return;
        }
        scheduleHeartbeat();
      };

      // Hard deadline: unconditional cancel.
      timers.push(this.clock.setTimer(() => void beginCancel('hard timeout exceeded'), hardMs));
      scheduleHeartbeat();

      // Host result channel. Uses the CURRENT evaluator so late results from a
      // superseded handle are judged against the current record (→ stale).
      handle.result.then(
        (r) => st.onResultEval?.(r, 'host'),
        (e) => {
          if (settled) {
            this.store.emit(st.record.logical_task_id, 'result_error_after_settle', { error: errMsg(e) });
            return;
          }
          const reason = `host error: ${errMsg(e)}`;
          set(this.store.transition(st.record, 'FAILED', { finished_at: this.toIso(), last_error: reason }));
          finish({ kind: 'failed', reason, record: st.record });
        },
      );
    });
  }
}
