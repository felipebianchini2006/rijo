import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { RunnerCapabilities } from '../agents/runner.js';
import {
  RpcAgentRunner,
  type RpcTransport,
  type HostCapabilities,
} from '../agents/rpc.js';
import type {
  HostAgentController,
  HostAttemptHandle,
  HostLiveness,
  CancelReceipt,
  TerminationReceipt,
  HostAttemptStatus,
  SupervisedAgentTask,
} from './controller.js';

/**
 * Method name a host advertises in its capability handshake to prove it can
 * hard-terminate a running turn (interrupt). Without it, forceTerminate is
 * NOT supported and the supervisor must fence instead of assuming a kill.
 */
export const FORCE_TERMINATE_METHOD = 'agent.forceTerminate';

const DEFAULT_CANCEL_ACK_TIMEOUT_MS = 5_000;
/** After this long without a heartbeat/progress signal, a pending attempt reads as not-alive. */
const DEFAULT_LIVENESS_TIMEOUT_MS = 30_000;

export interface RpcHostControllerOptions {
  /** Host label recorded on the task record. Default 'rpc'. */
  host?: string;
  /** Runner capabilities announced to the bridge. Default subagents-only. */
  capabilities?: RunnerCapabilities;
  /** Bounded wait for a cancel/force acknowledgement from the host (ms). */
  cancelAckTimeoutMs?: number;
  /** Freshness window: a pending attempt with no heartbeat within this many ms reads as not-alive. */
  livenessTimeoutMs?: number;
  /** Backstop per-task host timeout handed to the underlying RpcAgentRunner. */
  defaultTimeoutMs?: number;
  /** Injectable clock (ms since epoch) for deterministic liveness in tests. */
  now?: () => number;
  /**
   * Host capabilities negotiated at handshake. Its `methods` list decides
   * whether forceTerminate is supported. Also updated live from any
   * `host.capabilities` message observed on the transport.
   */
  hostCapabilities?: HostCapabilities;
  /** Observability: fired when a host heartbeat is materialised for an attempt. */
  onHeartbeat?: (attemptId: string | null) => void;
  /** Observability: fired when a host progress signal is materialised for an attempt. */
  onProgress?: (attemptId: string | null, detail: unknown) => void;
}

interface AttemptState {
  attemptId: string;
  leaseId: string | null;
  lastAliveAt: number;
  settled: boolean;
  cancelAcked: boolean;
  abort: AbortController;
  ackWaiters: Array<() => void>;
}

/**
 * HostAgentController implemented over the line-delimited JSON-RPC bridge
 * (src/agents/rpc.ts). It delegates each supervised attempt to an
 * RpcAgentRunner (`agent.runTask`) and adds the supervisor-facing control
 * surface on top of the wire protocol:
 *
 *   - liveness: host `agent.heartbeat`/`agent.progress` notifications are
 *     materialised into a per-attempt `lastAliveAt`, so the supervisor's
 *     heartbeat() poll sees real host activity (not model output);
 *   - requestCancel: sends `agent.cancelTask` and waits a BOUNDED time for an
 *     `agent.cancelled` ack (or the result settling), never indefinitely;
 *   - forceTerminate: sent ONLY when the negotiated handshake proves the host
 *     supports it; otherwise returns { terminated:false, method:'not_supported' }
 *     so the supervisor applies fencing;
 *   - query/dispose: real status and a bounded teardown (abort → CANCELLED).
 *
 * Transport EOF/error resolves every in-flight attempt via the runner
 * (HOST_DISCONNECTED); this controller also flips to a disconnected status.
 */
export class RpcHostController implements HostAgentController {
  readonly host: string;
  private readonly transport: RpcTransport;
  private readonly runner: RpcAgentRunner;
  private readonly attempts = new Map<string, AttemptState>();
  private readonly cancelAckTimeoutMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly onHeartbeat?: (attemptId: string | null) => void;
  private readonly onProgress?: (attemptId: string | null, detail: unknown) => void;
  private negotiatedMethods: Set<string>;
  private outboundId = 0;
  private disconnected = false;

  constructor(transport: RpcTransport, opts: RpcHostControllerOptions = {}) {
    this.transport = transport;
    this.host = opts.host ?? 'rpc';
    this.cancelAckTimeoutMs = opts.cancelAckTimeoutMs ?? DEFAULT_CANCEL_ACK_TIMEOUT_MS;
    this.livenessTimeoutMs = opts.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 20 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
    this.onHeartbeat = opts.onHeartbeat;
    this.onProgress = opts.onProgress;
    this.negotiatedMethods = new Set(opts.hostCapabilities?.methods ?? []);

    const capabilities: RunnerCapabilities = opts.capabilities ?? {
      subagents: true,
      parallelism: false,
      browser: false,
    };
    // The runner owns the runTask lifecycle (timeout, abort→CANCELLED, EOF→
    // HOST_DISCONNECTED). Its heartbeat/progress callbacks feed our liveness.
    this.runner = new RpcAgentRunner(transport, capabilities, {
      defaultTimeoutMs: this.defaultTimeoutMs,
      now: this.now,
      onHeartbeat: (attemptId) => this.markAlive(attemptId, () => this.onHeartbeat?.(attemptId)),
      onProgress: (attemptId, _leaseId, detail) => this.markAlive(attemptId, () => this.onProgress?.(attemptId, detail)),
    });

    // Observe the acks and capability handshake the runner does not surface.
    this.transport.onMessage((msg) => this.observe(msg));
    this.transport.onEnd?.(() => {
      this.disconnected = true;
    });
    this.transport.onError?.(() => {
      this.disconnected = true;
    });
  }

  async start(sup: SupervisedAgentTask, signal: AbortSignal): Promise<HostAttemptHandle> {
    const task: AgentTask = sup.task;
    const id = task.attempt?.attempt_id ?? task.id;
    const abort = new AbortController();
    const st: AttemptState = {
      attemptId: id,
      leaseId: task.attempt?.lease_id ?? null,
      lastAliveAt: this.now(),
      settled: false,
      cancelAcked: false,
      abort,
      ackWaiters: [],
    };
    this.attempts.set(id, st);

    // The supervisor's signal is the external/dispose HARD stop → abort the
    // runner (sends agent.cancelTask and settles CANCELLED). The graceful ladder
    // uses requestCancel/forceTerminate instead and never fires this signal.
    if (signal.aborted) abort.abort();
    else signal.addEventListener('abort', () => abort.abort(), { once: true });

    const result: Promise<AgentResult> = this.runner
      .runTask(task, { signal: abort.signal, timeoutMs: this.defaultTimeoutMs })
      .then((r) => {
        st.settled = true;
        this.flushAck(st);
        return r;
      });

    return {
      attempt_id: id,
      lease_id: st.leaseId ?? 'lease',
      generation: task.attempt?.generation ?? 1,
      host: this.host,
      process_id: null,
      result,
    };
  }

  async heartbeat(handle: HostAttemptHandle): Promise<HostLiveness> {
    const st = this.attempts.get(handle.attempt_id);
    if (!st) return { alive: false, detail: 'unknown attempt' };
    if (st.settled) return { alive: false, last_activity_ms: 0, detail: 'attempt settled' };
    if (this.disconnected) return { alive: false, detail: 'host disconnected' };
    const age = this.now() - st.lastAliveAt;
    const alive = age <= this.livenessTimeoutMs;
    return {
      alive,
      last_activity_ms: age,
      detail: alive ? `heartbeat ${age}ms ago` : `no heartbeat for ${age}ms`,
    };
  }

  async requestCancel(handle: HostAttemptHandle, reason: string): Promise<CancelReceipt> {
    const st = this.attempts.get(handle.attempt_id);
    if (!st) return { requested: false, acknowledged: false, detail: 'unknown attempt' };
    if (st.settled) return { requested: true, acknowledged: true, detail: 'already settled' };

    this.send('agent.cancelTask', { attempt_id: st.attemptId, lease_id: st.leaseId, reason });
    const acknowledged = await this.waitAck(st, this.cancelAckTimeoutMs);
    return {
      requested: true,
      acknowledged,
      detail: acknowledged ? 'host acknowledged cancel' : `no ack within ${this.cancelAckTimeoutMs}ms`,
    };
  }

  async forceTerminate(handle: HostAttemptHandle, reason: string): Promise<TerminationReceipt> {
    const st = this.attempts.get(handle.attempt_id);
    if (!st) return { terminated: false, method: 'not_supported', detail: 'unknown attempt' };
    if (st.settled) return { terminated: true, method: 'interrupt', detail: 'already settled' };
    if (!this.supportsForceTerminate()) {
      return { terminated: false, method: 'not_supported', detail: 'host did not advertise agent.forceTerminate' };
    }

    this.send(FORCE_TERMINATE_METHOD, { attempt_id: st.attemptId, lease_id: st.leaseId, reason });
    const acknowledged = await this.waitAck(st, this.cancelAckTimeoutMs);
    return acknowledged
      ? { terminated: true, method: 'interrupt', detail: 'host acknowledged force-terminate' }
      : { terminated: false, method: 'not_supported', detail: `no ack within ${this.cancelAckTimeoutMs}ms` };
  }

  async query(handle: HostAttemptHandle): Promise<HostAttemptStatus> {
    const st = this.attempts.get(handle.attempt_id);
    if (!st) return { kind: 'unknown' };
    if (st.settled) return { kind: 'completed' };
    if (this.disconnected) return { kind: 'disconnected' };
    const age = this.now() - st.lastAliveAt;
    if (age > this.livenessTimeoutMs) return { kind: 'dead', detail: `no heartbeat for ${age}ms` };
    return { kind: 'running' };
  }

  async dispose(handle: HostAttemptHandle): Promise<void> {
    const st = this.attempts.get(handle.attempt_id);
    if (!st) return;
    // Bounded teardown: abort the runner (settles CANCELLED if still pending).
    st.abort.abort();
    this.flushAck(st);
    this.attempts.delete(handle.attempt_id);
  }

  /** Whether the negotiated handshake proves hard-termination support. */
  supportsForceTerminate(): boolean {
    return this.negotiatedMethods.has(FORCE_TERMINATE_METHOD);
  }

  /**
   * Emit a control request on the transport. Ids are negative so they never
   * collide with the RpcAgentRunner's positive runTask/cancel ids; we correlate
   * on the `agent.cancelled` notification (by attempt), not on a response id.
   */
  private send(method: string, params: Record<string, unknown>): void {
    this.transport.send({ type: 'request', method, id: --this.outboundId, params });
  }

  private markAlive(attemptId: string | null, notify: () => void): void {
    if (attemptId != null) {
      const st = this.attempts.get(attemptId);
      if (st) st.lastAliveAt = this.now();
    }
    notify();
  }

  private observe(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; method?: string; params?: Record<string, unknown> };

    if (m.type === 'notification' && m.method === 'agent.cancelled') {
      const attemptId = (m.params?.attempt_id as string | undefined) ?? null;
      if (attemptId != null) {
        const st = this.attempts.get(attemptId);
        if (st) {
          st.cancelAcked = true;
          this.flushAck(st);
        }
      }
      return;
    }

    // Capability handshake — either a notification or a response carrying the shape.
    if (m.method === 'host.capabilities' || (m.type === 'notification' && m.method === 'host.capabilities')) {
      this.mergeCapabilities(m.params);
    }
  }

  private mergeCapabilities(params: unknown): void {
    const methods = (params as { methods?: unknown } | undefined)?.methods;
    if (Array.isArray(methods)) {
      for (const method of methods) if (typeof method === 'string') this.negotiatedMethods.add(method);
    }
  }

  private waitAck(st: AttemptState, timeoutMs: number): Promise<boolean> {
    if (st.cancelAcked || st.settled) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        resolve(v);
      };
      st.ackWaiters.push(() => finish(true));
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  private flushAck(st: AttemptState): void {
    const waiters = st.ackWaiters.splice(0);
    for (const w of waiters) w();
  }
}
