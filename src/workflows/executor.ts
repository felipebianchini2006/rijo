import { RijoPaths } from '../core/paths.js';
import type { ModelRole, SupervisorConfig } from '../core/schemas/index.js';
import { AgentResultSchema, enforceWriteScope, type AgentTask, type AgentResult } from '../agents/protocol.js';
import type { AgentRunner, RunnerCapabilities } from '../agents/runner.js';
import type { HostAgentController } from '../hosts/controller.js';
import { InProcessController } from '../supervisor/runnerController.js';
import { Supervisor, type PreparedAttempt } from '../supervisor/supervisor.js';
import type { Clock } from '../supervisor/clock.js';

/**
 * One supervised dispatch: the gen-1 task (already carrying its isolated
 * workspace, or null for a read-only task) plus its role and an OPTIONAL
 * factory that yields a brand-new attempt (fresh task + fresh workspace) for
 * every replacement generation. The factory is invoked ONLY for generations
 * beyond the first — the supervisor never reuses a failed attempt's workspace
 * when a replacement is requested.
 */
export interface SupervisedDispatch {
  task: AgentTask;
  role: ModelRole;
  prepareReplacement?: (generation: number, previousFailure: string) => PreparedAttempt | Promise<PreparedAttempt>;
}

/**
 * The single authority that turns a briefed task into a validated AgentResult.
 * Every workflow dispatch goes through here — never through the AgentRunner
 * directly — so that a durable TaskRecord is created before any host starts,
 * each attempt gets its own generation/lease/idempotency identity, and no
 * late, duplicated or fenced result can ever be applied. The concrete host is
 * pluggable: the default wraps the context's in-process AgentRunner, while a
 * real host controller (Claude/Codex/RPC) can be injected without touching the
 * workflows.
 */
export interface TaskExecutor {
  readonly capabilities: RunnerCapabilities;
  /** Supervise ONE task to a terminal outcome. Resolves with a validated result (success or a BLOCKED/CANCELLED diagnostic). */
  run(req: SupervisedDispatch): Promise<AgentResult>;
  /**
   * Supervise a batch with INDEPENDENT per-task supervision: a task stuck at
   * its own deadline never blocks the others beyond that deadline. Results are
   * returned in input order.
   */
  runBatch(reqs: SupervisedDispatch[], maxParallel: number): Promise<AgentResult[]>;
  /** Stop all in-flight supervision (cancel active attempts, clear timers). */
  dispose(): Promise<void>;
}

export interface SupervisedExecutorOptions {
  controller: HostAgentController;
  config: SupervisorConfig;
  paths: RijoPaths;
  capabilities: RunnerCapabilities;
  clock?: Clock;
}

/**
 * The production TaskExecutor. Owns exactly one Supervisor (which owns the
 * durable TaskStore) and drives every dispatch through `superviseTask`.
 */
export class SupervisedExecutor implements TaskExecutor {
  readonly capabilities: RunnerCapabilities;
  private readonly supervisor: Supervisor;

  constructor(opts: SupervisedExecutorOptions) {
    this.capabilities = opts.capabilities;
    this.supervisor = new Supervisor({
      controller: opts.controller,
      config: opts.config,
      paths: opts.paths,
      clock: opts.clock,
    });
  }

  async run(req: SupervisedDispatch): Promise<AgentResult> {
    const raw = await this.supervisor.superviseTask(req.task, {
      role: req.role,
      expertProfiles: req.task.expert_profiles,
      ...(req.prepareReplacement ? { prepareAttempt: req.prepareReplacement } : {}),
    });
    return this.validate(req.task, raw);
  }

  async runBatch(reqs: SupervisedDispatch[], maxParallel: number): Promise<AgentResult[]> {
    const results = new Array<AgentResult>(reqs.length);
    let firstError: unknown = null;
    let hasError = false;

    const runOne = async (index: number): Promise<void> => {
      const settled = await Promise.allSettled([this.run(reqs[index]!)]);
      const outcome = settled[0]!;
      if (outcome.status === 'fulfilled') {
        results[index] = outcome.value;
      } else if (!hasError) {
        hasError = true;
        firstError = outcome.reason;
      }
    };

    const parallel = this.capabilities.parallelism && maxParallel > 1 ? maxParallel : 1;
    // Independent supervision per task: each item is bounded by its own
    // deadline inside the supervisor, so a stuck task cannot starve the batch.
    for (let i = 0; i < reqs.length; i += parallel) {
      const slice = reqs.slice(i, i + parallel).map((_, j) => runOne(i + j));
      await Promise.all(slice);
    }

    // A thrown scope violation (the only throw path) is surfaced only after
    // every task has settled, preserving batch independence.
    if (hasError) throw firstError;
    return results;
  }

  async dispose(): Promise<void> {
    await this.supervisor.dispose();
  }

  /**
   * Apply the same validation runValidated used to apply: schema-parse the
   * result and, for a successful write task, the courtesy write-scope check.
   * The authoritative scope guard remains the workflow's filesystem-diff.
   */
  private validate(task: AgentTask, raw: AgentResult): AgentResult {
    const result = AgentResultSchema.parse(raw);
    if (result.ok && task.write_scope.length > 0) enforceWriteScope(task, result);
    return result;
  }
}

/**
 * Build the default executor for a workflow context: the in-process AgentRunner
 * wrapped in an InProcessController, driven by the given supervisor config.
 * Real host controllers (Claude/Codex/RPC), where replacement is meaningful,
 * are injected instead via `deps.executor`.
 */
export function defaultExecutor(
  runner: AgentRunner,
  config: SupervisorConfig,
  paths: RijoPaths,
  clock?: Clock,
): TaskExecutor {
  return new SupervisedExecutor({
    controller: new InProcessController(runner),
    config,
    paths,
    capabilities: runner.capabilities,
    ...(clock ? { clock } : {}),
  });
}
