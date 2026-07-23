import { AgentResultSchema, enforceWriteScope, type AgentTask, type AgentResult } from './protocol.js';

export interface RunnerCapabilities {
  subagents: boolean;
  parallelism: boolean;
  browser: boolean;
}

/**
 * Injectable agent runtime. The core never imports a provider SDK — adapters
 * or embedders supply an implementation. Capabilities are honest: if the
 * platform cannot run something, the flag is false and RIJO degrades
 * explicitly (sequential fallback, BLOCKED readiness) instead of simulating.
 */
export interface AgentRunner {
  readonly capabilities: RunnerCapabilities;
  runTask(task: AgentTask): Promise<AgentResult>;
}

/**
 * Run a batch of independent tasks. Parallel only when the runtime supports
 * it; otherwise the same roles run sequentially in the same order.
 */
export async function runBatch(
  runner: AgentRunner,
  tasks: AgentTask[],
  maxParallel: number,
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];
  if (runner.capabilities.parallelism && maxParallel > 1) {
    for (let i = 0; i < tasks.length; i += maxParallel) {
      const slice = tasks.slice(i, i + maxParallel);
      const settled = await Promise.all(slice.map((t) => runValidated(runner, t)));
      results.push(...settled);
    }
  } else {
    for (const task of tasks) results.push(await runValidated(runner, task));
  }
  return results;
}

export async function runValidated(runner: AgentRunner, task: AgentTask): Promise<AgentResult> {
  const raw = await runner.runTask(task);
  const result = AgentResultSchema.parse(raw);
  if (result.ok && task.write_scope.length > 0) enforceWriteScope(task, result);
  return result;
}

export type FakeHandler = (task: AgentTask) => AgentResult | Promise<AgentResult>;

/**
 * Deterministic test/dry-run runner. Handlers are matched by task role or id
 * prefix; unmatched tasks succeed with an empty confirmation.
 */
export class FakeAgentRunner implements AgentRunner {
  public readonly executed: AgentTask[] = [];
  constructor(
    public readonly capabilities: RunnerCapabilities = { subagents: true, parallelism: true, browser: false },
    private readonly handlers: Array<{ match: (t: AgentTask) => boolean; handle: FakeHandler }> = [],
  ) {}

  /** Later registrations take precedence (useful to override defaults in tests). */
  on(match: (t: AgentTask) => boolean, handle: FakeHandler): this {
    this.handlers.unshift({ match, handle });
    return this;
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    this.executed.push(task);
    const handler = this.handlers.find((h) => h.match(task));
    if (handler) return handler.handle(task);
    return {
      task_id: task.id,
      ok: true,
      summary: `fake:${task.role} completed ${task.id}`,
      files_written: [],
      payload: null,
      scope_requests: [],
    };
  }
}

/**
 * Placeholder runner used when no runtime is bound: refuses to pretend.
 * Workflows that need agents stop with a precise diagnostic instead of
 * simulating agent work.
 */
export class UnboundAgentRunner implements AgentRunner {
  readonly capabilities: RunnerCapabilities = { subagents: false, parallelism: false, browser: false };
  async runTask(task: AgentTask): Promise<AgentResult> {
    return {
      task_id: task.id,
      ok: false,
      summary:
        'No agent runtime bound. Run RIJO through an adapter (Claude Code / Codex skills) or bind an AgentRunner programmatically.',
      files_written: [],
      payload: null,
      scope_requests: [],
    };
  }
}
