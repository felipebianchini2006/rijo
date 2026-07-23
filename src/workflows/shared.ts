import { RijoPaths } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { ProgressBus, consoleSink, newRunId, type ProgressSink } from '../core/progress.js';
import { acquireLock, releaseLock } from '../core/locks.js';
import type { RijoConfig } from '../core/schemas/index.js';
import type { AgentRunner } from '../agents/runner.js';
import { UnboundAgentRunner } from '../agents/runner.js';
import type { ShellRunner } from '../core/commands.js';
import { SystemShellRunner } from '../core/commands.js';
import type { GitOps } from '../core/git.js';
import { SystemGit } from '../core/git.js';

export interface WorkflowContext {
  projectRoot: string;
  paths: RijoPaths;
  config: RijoConfig;
  bus: ProgressBus;
  runner: AgentRunner;
  shell: ShellRunner;
  git: GitOps;
  now: () => Date;
}

export interface WorkflowDeps {
  runner?: AgentRunner;
  shell?: ShellRunner;
  git?: GitOps;
  sink?: ProgressSink;
  now?: () => Date;
}

export function createContext(projectRoot: string, deps: WorkflowDeps = {}): WorkflowContext {
  const paths = new RijoPaths(projectRoot);
  const now = deps.now ?? (() => new Date());
  return {
    projectRoot,
    paths,
    config: loadConfig(paths),
    bus: new ProgressBus(paths, newRunId(now), deps.sink ?? consoleSink, now),
    runner: deps.runner ?? new UnboundAgentRunner(),
    shell: deps.shell ?? new SystemShellRunner(),
    git: deps.git ?? new SystemGit(),
    now,
  };
}

export class BlockedError extends Error {
  constructor(
    message: string,
    public readonly diagnostic: string,
  ) {
    super(message);
    this.name = 'BlockedError';
  }
}

/** Run a workflow body under the runtime lock; always releases. */
export async function withLock<T>(ctx: WorkflowContext, body: () => Promise<T>): Promise<T> {
  acquireLock(ctx.paths.lock, ctx.bus.runId, ctx.now);
  try {
    return await body();
  } finally {
    releaseLock(ctx.paths.lock, ctx.bus.runId);
  }
}

export interface WorkflowOutcome {
  ok: boolean;
  status: 'completed' | 'blocked' | 'failed';
  message: string;
  details?: string[];
}

export function blocked(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  ctx.bus.emit('workflow.blocked', { status: 'blocked', message }, { details });
  return { ok: false, status: 'blocked', message, details };
}

export function failed(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  ctx.bus.emit('workflow.failed', { status: 'failed', message }, { details });
  return { ok: false, status: 'failed', message, details };
}

export function completed(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  ctx.bus.emit('workflow.completed', { status: 'completed', message }, { details });
  return { ok: true, status: 'completed', message, details };
}
