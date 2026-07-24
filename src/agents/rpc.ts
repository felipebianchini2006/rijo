import * as readline from 'node:readline';
import { AgentResultSchema, type AgentTask, type AgentResult, type AgentAttemptIdentity } from './protocol.js';
import type { AgentRunner, RunnerCapabilities } from './runner.js';

/**
 * Line-delimited JSON-RPC transport. The host and the core speak over a single
 * bidirectional pipe: every message is one JSON object on its own line.
 * Message shapes (all `type`-tagged):
 *   - request:      { type:'request', method, id, params }
 *   - response:     { type:'response', id, result }  OR  { type:'response', id, error }
 *   - notification: { type:'notification', method, params }
 *
 * PROTOCOL v2 methods:
 *   - core → host  request:      'agent.runTask'   (params = AgentTask)
 *   - core → host  request:      'agent.cancelTask'({ attempt_id, lease_id, reason })
 *   - core → host  notification: 'progress'        (workflow-level progress)
 *   - core → host  notification: 'host.capabilities' (announced on start)
 *   - core ↔ host  request:      'host.shutdown'   (coordinated teardown)
 *   - host → core  request:      'workflow.<name>' (params = workflow options)
 *   - host → core  request:      'host.capabilities' (echoed back by the core)
 *   - host → core  notification: 'agent.heartbeat' ({ attempt_id, lease_id })
 *   - host → core  notification: 'agent.progress'  ({ attempt_id, lease_id, detail })
 *   - host → core  notification: 'agent.result'    (alias for a runTask response,
 *                                                    { id, result|error })
 *   - host → core  notification: 'agent.cancelled' (ack for agent.cancelTask)
 *
 * v1 hosts that never send capabilities keep working with the runTask subset.
 */
export interface RpcTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  /** Optional: invoked when the underlying pipe closes (stdin end / EOF). */
  onEnd?(cb: () => void): void;
  /** Optional: invoked on a transport-level error (broken pipe, read error). */
  onError?(cb: (err: unknown) => void): void;
}

/** Protocol version the core speaks. */
export const PROTOCOL_VERSION = 2;

/** Methods advertised in the host.capabilities handshake. */
export const CORE_METHODS = [
  'workflow.new',
  'workflow.run',
  'workflow.ui',
  'workflow.fix',
  'workflow.check',
  'host.capabilities',
  'host.shutdown',
  'agent.runTask',
  'agent.cancelTask',
  'agent.heartbeat',
  'agent.progress',
  'agent.result',
  'agent.cancelled',
] as const;

export interface HostCapabilities {
  protocol_version: number;
  methods: string[];
}

export function coreCapabilities(): HostCapabilities {
  return { protocol_version: PROTOCOL_VERSION, methods: [...CORE_METHODS] };
}

/**
 * Stdio transport: reads process.stdin as newline-delimited JSON and writes
 * JSON.stringify(msg)+'\n' to process.stdout. NOTHING non-JSON is ever written
 * to stdout — progress and logs travel as JSON notifications so the stream
 * stays machine-parseable for the host on the other end.
 */
export class StdioTransport implements RpcTransport {
  private readonly handlers: Array<(msg: any) => void> = [];
  private readonly endHandlers: Array<() => void> = [];
  private readonly errorHandlers: Array<(err: unknown) => void> = [];
  private started = false;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    const rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        // Non-JSON line on the wire: ignore rather than crash the bridge.
        return;
      }
      for (const h of this.handlers) h(msg);
    });
    rl.on('close', () => {
      for (const h of this.endHandlers) h();
    });
    this.input.on('error', (err) => {
      for (const h of this.errorHandlers) h(err);
    });
    // A broken downstream pipe must not crash the process with an uncaught
    // 'error' event; surface it to error handlers instead.
    this.output.on('error', (err) => {
      for (const h of this.errorHandlers) h(err);
    });
  }

  send(msg: unknown): void {
    try {
      this.output.write(JSON.stringify(msg) + '\n');
    } catch {
      // Downstream closed mid-write: swallow (error handlers drive shutdown).
    }
  }

  onMessage(cb: (msg: any) => void): void {
    this.handlers.push(cb);
    this.ensureStarted();
  }

  onEnd(cb: () => void): void {
    this.endHandlers.push(cb);
    this.ensureStarted();
  }

  onError(cb: (err: unknown) => void): void {
    this.errorHandlers.push(cb);
    this.ensureStarted();
  }
}

/** Default host timeout for a single agent task: 20 minutes. */
export const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;

export interface RunTaskOptions {
  /** Abort the task: sends agent.cancelTask to the host, resolves ok:false CANCELLED. */
  signal?: AbortSignal;
  /** Override the per-task host timeout (ms). <=0 or non-finite disables it. */
  timeoutMs?: number;
}

export interface RpcAgentRunnerOptions {
  /** Default host timeout applied to every task without an explicit timeoutMs. */
  defaultTimeoutMs?: number;
  /** Injectable clock (ms since epoch) — for deterministic ageMs in tests. */
  now?: () => number;
  /** Fired when a duplicate/late response arrives for an already-settled id. */
  onLate?: (id: number, envelope: unknown) => void;
  /** Fired on host→core agent.heartbeat notifications. */
  onHeartbeat?: (attemptId: string | null, leaseId: string | null) => void;
  /** Fired on host→core agent.progress notifications. */
  onProgress?: (attemptId: string | null, leaseId: string | null, detail: unknown) => void;
}

interface Pending {
  id: number;
  taskId: string;
  attempt: AgentAttemptIdentity | null;
  createdAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: AgentResult) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
  settled: boolean;
}

/** Terminal, never-throwing failure result. Used for every non-success path. */
function failure(taskId: string, summary: string): AgentResult {
  return {
    task_id: taskId,
    ok: false,
    summary,
    files_written: [],
    payload: null,
    scope_requests: [],
    attempt_id: null,
    generation: null,
    lease_id: null,
  };
}

/**
 * AgentRunner backed by an RPC transport. Each task becomes an 'agent.runTask'
 * request the host answers with an AgentResult. The core never runs a model
 * itself: it delegates to whatever host (Claude Code, Codex, …) is on the other
 * end of the pipe.
 *
 * Resilience guarantees:
 *   - every task has a host timeout (default 20min) → resolves ok:false HOST_TIMEOUT;
 *   - an AbortSignal cancels the task on the host and resolves ok:false CANCELLED;
 *   - transport EOF/error resolves ALL pendings ok:false HOST_DISCONNECTED;
 *   - a response only settles the FIRST time; duplicates go to onLate and are ignored;
 *   - a response whose attempt echo diverges from a supervised pending is discarded
 *     (the pending stays until it times out) — a stale attempt never resolves the wrong one;
 *   - a response for an unknown/reused id never resolves any task;
 *   - timers are ALWAYS cleared on settle; nothing ever rejects (zero unhandled rejections).
 */
export class RpcAgentRunner implements AgentRunner {
  public readonly capabilities: RunnerCapabilities;
  private readonly pending = new Map<number, Pending>();
  /** Every id ever dispatched — distinguishes "late duplicate" from "unknown id". */
  private readonly dispatched = new Set<number>();
  private counter = 0;
  private disposed = false;

  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly onLate?: (id: number, envelope: unknown) => void;
  private readonly onHeartbeat?: (attemptId: string | null, leaseId: string | null) => void;
  private readonly onProgress?: (attemptId: string | null, leaseId: string | null, detail: unknown) => void;

  constructor(
    private readonly transport: RpcTransport,
    capabilities: RunnerCapabilities,
    opts: RpcAgentRunnerOptions = {},
  ) {
    this.capabilities = capabilities;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    this.now = opts.now ?? (() => Date.now());
    this.onLate = opts.onLate;
    this.onHeartbeat = opts.onHeartbeat;
    this.onProgress = opts.onProgress;
    // Reacts to agent responses/notifications; workflow requests are routed elsewhere.
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onEnd?.(() => this.disconnect('HOST_DISCONNECTED'));
    this.transport.onError?.(() => this.disconnect('HOST_DISCONNECTED'));
  }

  runTask(task: AgentTask, opts: RunTaskOptions = {}): Promise<AgentResult> {
    const id = ++this.counter;
    this.dispatched.add(id);
    return new Promise<AgentResult>((resolve, reject) => {
      if (this.disposed) {
        resolve(failure(task.id, 'HOST_DISCONNECTED'));
        return;
      }
      const signal = opts.signal;

      const onAbort = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.cancelOnHost(p, 'aborted');
        this.settle(p, failure(task.id, 'CANCELLED'));
      };

      const cleanup = () => {
        this.pending.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      const timer =
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? setTimeout(() => {
              const p = this.pending.get(id);
              if (!p) return;
              this.cancelOnHost(p, 'timeout');
              this.settle(p, failure(task.id, 'HOST_TIMEOUT'));
            }, timeoutMs)
          : null;
      if (timer && typeof timer.unref === 'function') timer.unref();

      const pending: Pending = {
        id,
        taskId: task.id,
        attempt: task.attempt ?? null,
        createdAt: this.now(),
        timer,
        resolve,
        reject,
        cleanup,
        settled: false,
      };
      this.pending.set(id, pending);

      // Already aborted before dispatch: resolve without touching the host.
      if (signal?.aborted) {
        this.settle(pending, failure(task.id, 'CANCELLED'));
        return;
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.transport.send({ type: 'request', method: 'agent.runTask', id, params: task });
    });
  }

  /** Diagnostic snapshot of in-flight tasks. */
  listPending(): Array<{ id: number; taskId: string; attempt_id: string | null; ageMs: number }> {
    const now = this.now();
    return [...this.pending.values()]
      .filter((p) => !p.settled)
      .map((p) => ({ id: p.id, taskId: p.taskId, attempt_id: p.attempt?.attempt_id ?? null, ageMs: now - p.createdAt }));
  }

  /**
   * Resolve every in-flight task with ok:false `code`, optionally telling the
   * host to cancel each one first. Used for shutdown and workflow deadlines.
   */
  cancelAll(code = 'CANCELLED', notifyHost = true): void {
    for (const p of [...this.pending.values()]) {
      if (notifyHost) this.cancelOnHost(p, code);
      this.settle(p, failure(p.taskId, code));
    }
  }

  /** Stop reacting to transport messages (message fan-out has no unsubscribe). */
  dispose(): void {
    this.disposed = true;
    this.cancelAll('HOST_DISCONNECTED', false);
  }

  private disconnect(code: string): void {
    for (const p of [...this.pending.values()]) this.settle(p, failure(p.taskId, code));
  }

  private settle(p: Pending, result: AgentResult): void {
    if (p.settled) return;
    p.settled = true;
    if (p.timer) clearTimeout(p.timer);
    p.cleanup();
    p.resolve(result);
  }

  private cancelOnHost(p: Pending, reason: string): void {
    const cancelId = ++this.counter;
    this.transport.send({
      type: 'request',
      method: 'agent.cancelTask',
      id: cancelId,
      params: { attempt_id: p.attempt?.attempt_id ?? null, lease_id: p.attempt?.lease_id ?? null, reason },
    });
  }

  private handleMessage(msg: any): void {
    if (this.disposed || !msg || typeof msg !== 'object') return;

    if (msg.type === 'notification') {
      switch (msg.method) {
        case 'agent.heartbeat': {
          const params = msg.params ?? {};
          this.onHeartbeat?.(params.attempt_id ?? null, params.lease_id ?? null);
          return;
        }
        case 'agent.progress': {
          const params = msg.params ?? {};
          this.onProgress?.(params.attempt_id ?? null, params.lease_id ?? null, params.detail);
          return;
        }
        case 'agent.cancelled':
          // Ack for a cancel we already applied locally — idempotent no-op.
          return;
        case 'agent.result': {
          const params = msg.params ?? {};
          this.routeResult(params.id, params);
          return;
        }
        default:
          return;
      }
    }

    if (msg.type === 'response' && typeof msg.method !== 'string') {
      this.routeResult(msg.id, msg);
    }
  }

  private routeResult(id: unknown, env: { result?: unknown; error?: unknown }): void {
    if (typeof id !== 'number') return;
    const p = this.pending.get(id);
    if (!p) {
      // Known-but-already-settled → late duplicate; otherwise a stranger id.
      if (this.dispatched.has(id)) this.onLate?.(id, env);
      return;
    }

    if (env.error !== undefined) {
      const summary = typeof env.error === 'string' ? env.error : JSON.stringify(env.error);
      this.settle(p, failure(p.taskId, summary));
      return;
    }

    const parsed = AgentResultSchema.safeParse(env.result);
    if (!parsed.success) {
      this.settle(p, failure(p.taskId, `Host returned an invalid AgentResult: ${parsed.error.message}`));
      return;
    }
    const result = parsed.data;

    // Supervised attempt: the echo MUST match, else this is a stale/misrouted
    // reply. Discard it and keep the pending alive until it times out — never
    // let a stale attempt resolve the current one.
    if (p.attempt && result.attempt_id !== p.attempt.attempt_id) return;

    this.settle(p, result);
  }
}
