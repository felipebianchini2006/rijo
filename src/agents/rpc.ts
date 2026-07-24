import * as readline from 'node:readline';
import { AgentResultSchema, type AgentTask, type AgentResult } from './protocol.js';
import type { AgentRunner, RunnerCapabilities } from './runner.js';

/**
 * Line-delimited JSON-RPC transport. The host and the core speak over a single
 * bidirectional pipe: every message is one JSON object on its own line.
 * Message shapes (all `type`-tagged):
 *   - request:      { type:'request', method, id, params }
 *   - response:     { type:'response', id, result }  OR  { type:'response', id, error }
 *   - notification: { type:'notification', method, params }
 *
 * There are exactly two request methods in play:
 *   - core → host:  method 'agent.runTask'   (params = AgentTask)
 *   - host → core:  method 'workflow.<name>' (params = workflow options)
 * Progress is a core → host notification with method 'progress'.
 */
export interface RpcTransport {
  send(msg: unknown): void;
  onMessage(cb: (msg: any) => void): void;
  /** Optional: invoked when the underlying pipe closes (stdin end). */
  onEnd?(cb: () => void): void;
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
  }

  send(msg: unknown): void {
    this.output.write(JSON.stringify(msg) + '\n');
  }

  onMessage(cb: (msg: any) => void): void {
    this.handlers.push(cb);
    this.ensureStarted();
  }

  onEnd(cb: () => void): void {
    this.endHandlers.push(cb);
    this.ensureStarted();
  }
}

interface Pending {
  taskId: string;
  resolve: (result: AgentResult) => void;
}

/**
 * AgentRunner backed by an RPC transport. Each task becomes an
 * 'agent.runTask' request the host answers with an AgentResult. The core never
 * runs a model itself: it delegates to whatever host (Claude Code, Codex, …)
 * is on the other end of the pipe.
 */
export class RpcAgentRunner implements AgentRunner {
  public readonly capabilities: RunnerCapabilities;
  private readonly pending = new Map<number, Pending>();
  private counter = 0;

  constructor(
    private readonly transport: RpcTransport,
    capabilities: RunnerCapabilities,
  ) {
    this.capabilities = capabilities;
    // Only reacts to agent responses whose id is in our pending map; workflow
    // requests and unrelated messages are ignored here (routed elsewhere).
    this.transport.onMessage((msg) => this.handleMessage(msg));
  }

  private handleMessage(msg: any): void {
    if (!msg || msg.type !== 'response' || typeof msg.method === 'string') return;
    const id = msg.id;
    if (typeof id !== 'number' || !this.pending.has(id)) return;
    const { taskId, resolve } = this.pending.get(id)!;
    this.pending.delete(id);
    if (msg.error !== undefined) {
      resolve({
        task_id: taskId,
        ok: false,
        summary: typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error),
        files_written: [],
        payload: null,
        scope_requests: [],
      attempt_id: null,
      generation: null,
      lease_id: null,
      });
      return;
    }
    const parsed = AgentResultSchema.safeParse(msg.result);
    if (!parsed.success) {
      resolve({
        task_id: taskId,
        ok: false,
        summary: `Host returned an invalid AgentResult: ${parsed.error.message}`,
        files_written: [],
        payload: null,
        scope_requests: [],
      attempt_id: null,
      generation: null,
      lease_id: null,
      });
      return;
    }
    resolve(parsed.data);
  }

  runTask(task: AgentTask): Promise<AgentResult> {
    const id = ++this.counter;
    return new Promise<AgentResult>((resolve) => {
      this.pending.set(id, { taskId: task.id, resolve });
      this.transport.send({ type: 'request', method: 'agent.runTask', id, params: task });
    });
  }
}
