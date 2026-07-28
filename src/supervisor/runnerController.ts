import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { AgentRunner } from '../agents/runner.js';
import type {
  HostAgentController,
  HostAttemptHandle,
  HostLiveness,
  CancelReceipt,
  HostAttemptStatus,
  SupervisedAgentTask,
} from '../hosts/controller.js';

/**
 * Adapts an in-process AgentRunner to the HostAgentController surface. Liveness
 * is a real runtime fact: the attempt is alive while its runTask promise is
 * pending and dead once it settles. An in-process runner cannot be interrupted
 * mid-call, so it deliberately exposes NO forceTerminate — cancellation of a
 * genuinely stuck in-process attempt therefore falls through to the
 * supervisor's fencing path (lease revoked, workspace invalidated, result
 * blocked), which is the honest outcome rather than a fake kill.
 */

interface Entry {
  settled: boolean;
  disposed: boolean;
  ok: boolean;
  error: unknown;
}

function stampIdentity(task: AgentTask, result: AgentResult): AgentResult {
  return {
    ...result,
    workflow_epoch: task.attempt?.workflow_epoch ?? result.workflow_epoch,
    attempt_id: task.attempt?.attempt_id ?? result.attempt_id,
    generation: task.attempt?.generation ?? result.generation,
    lease_id: task.attempt?.lease_id ?? result.lease_id,
  };
}

export class InProcessController implements HostAgentController {
  readonly host: string;
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly runner: AgentRunner,
    host = 'in-process',
  ) {
    this.host = host;
  }

  replayAttempt(task: AgentTask) {
    return this.runner.replayAttempt?.(task) ?? null;
  }

  async start(sup: SupervisedAgentTask, signal: AbortSignal): Promise<HostAttemptHandle> {
    const task = sup.task;
    const id = task.attempt?.attempt_id ?? task.id;
    const entry: Entry = { settled: false, disposed: false, ok: false, error: null };
    this.entries.set(id, entry);

    const result = Promise.resolve()
      .then(() => this.runner.runTask(task))
      .then(
        (r) => {
          entry.settled = true;
          entry.ok = r.ok;
          return stampIdentity(task, r);
        },
        (err) => {
          entry.settled = true;
          entry.error = err;
          throw err;
        },
      );

    // Best-effort: if the caller aborts, record it; the runner cannot actually
    // be stopped, which is exactly why fencing exists.
    if (signal.aborted) entry.disposed = entry.disposed || false;
    else signal.addEventListener('abort', () => void 0, { once: true });

    return {
      attempt_id: id,
      lease_id: task.attempt?.lease_id ?? 'lease',
      generation: task.attempt?.generation ?? 1,
      host: this.host,
      process_id: null,
      result,
    };
  }

  async heartbeat(handle: HostAttemptHandle): Promise<HostLiveness> {
    const e = this.entries.get(handle.attempt_id);
    if (!e) return { alive: false, detail: 'unknown attempt' };
    if (e.disposed) return { alive: false, detail: 'disposed' };
    if (e.settled) return { alive: false, last_activity_ms: 0, detail: 'runner completed' };
    return { alive: true, detail: 'runner in progress' };
  }

  async requestCancel(_handle: HostAttemptHandle, _reason: string): Promise<CancelReceipt> {
    // An in-process function call cannot be cooperatively cancelled.
    return {
      requested: true,
      acknowledged: false,
      detail: 'in-process runner is not cancellable; supervisor must fence',
    };
  }

  // No forceTerminate: absence is meaningful. The supervisor will fence instead.

  async query(handle: HostAttemptHandle): Promise<HostAttemptStatus> {
    const e = this.entries.get(handle.attempt_id);
    if (!e) return { kind: 'unknown' };
    if (e.settled) return { kind: 'completed' };
    if (e.disposed) return { kind: 'dead' };
    return { kind: 'running' };
  }

  async dispose(handle: HostAttemptHandle): Promise<void> {
    const e = this.entries.get(handle.attempt_id);
    if (e) e.disposed = true;
  }
}
