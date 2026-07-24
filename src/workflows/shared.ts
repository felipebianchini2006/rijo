import { RijoPaths } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { ProgressBus, consoleSink, newRunId, type ProgressSink } from '../core/progress.js';
import { acquireLock, releaseLock } from '../core/locks.js';
import { readState, writeState } from '../core/state.js';
import { SchemaMismatchError, touchManifest } from '../core/manifest.js';
import { ensureSchemaCompatible, MigrationError } from '../core/migrate.js';
import { exists } from '../core/fsx.js';
import type { RijoConfig } from '../core/schemas/index.js';
import type { AgentRunner } from '../agents/runner.js';
import { UnboundAgentRunner, runBatch, runValidated } from '../agents/runner.js';
import { tierFor } from '../agents/roles.js';
import { AgentTaskSchema, type AgentTask, type AgentTaskDraft, type AgentResult } from '../agents/protocol.js';
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
  const config = loadConfig(paths);
  return {
    projectRoot,
    paths,
    config,
    bus: new ProgressBus(paths, newRunId(now), deps.sink ?? consoleSink, now),
    runner: deps.runner ?? new UnboundAgentRunner(),
    shell: deps.shell ?? new SystemShellRunner(config.execution),
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

/**
 * Guard against running against an incompatible on-disk schema. An OLDER
 * schema is migrated in place (backup + deterministic transform) before the
 * workflow proceeds; a NEWER schema blocks — an old build never touches a
 * newer project. Returns a blocked outcome on failure, null when compatible.
 */
export function guardSchema(ctx: WorkflowContext): WorkflowOutcome | null {
  try {
    const report = ensureSchemaCompatible(ctx.paths, ctx.now);
    if (report && report.changed.length > 0) {
      ctx.bus.emit('schema.migrated', {
        message: `schema migrado v${report.from} → v${report.to} (backup em ${report.backupDir})`,
      });
    }
    return null;
  } catch (err) {
    if (err instanceof SchemaMismatchError || err instanceof MigrationError) {
      return blocked(ctx, 'Schema version mismatch.', [err instanceof Error ? err.message : String(err)]);
    }
    throw err;
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

/**
 * Inject the role's configured model tier into a task and run it. This is how
 * model routing becomes operational: the deterministic core resolves tier from
 * config.yml and the runner (or host bridge) receives it on every task.
 */
export async function dispatch(ctx: WorkflowContext, task: AgentTaskDraft): Promise<AgentResult> {
  const full: AgentTask = AgentTaskSchema.parse({ ...task, tier: task.tier ?? tierFor(ctx.config, task.role) });
  return runValidated(ctx.runner, full);
}

export async function dispatchBatch(ctx: WorkflowContext, tasks: AgentTaskDraft[], max?: number): Promise<AgentResult[]> {
  const withTier = tasks.map((t) => AgentTaskSchema.parse({ ...t, tier: t.tier ?? tierFor(ctx.config, t.role) }));
  return runBatch(ctx.runner, withTier, max ?? ctx.config.limits.max_parallel_agents);
}

export function blocked(ctx: WorkflowContext, message: string, details: string[] = []): WorkflowOutcome {
  ctx.bus.emit('workflow.blocked', { status: 'blocked', message }, { details });
  // Persist the blocked state durably ONLY when a run is actually in progress
  // (a phase is active) — so a later `rijo --status` and the next run see the
  // true situation. Pure input-validation refusals (no project, wrong flags,
  // re-init without --next) must stay fully non-destructive and never touch state.
  try {
    if (exists(ctx.paths.state)) {
      const prev = readState(ctx.paths);
      if (prev && prev.phase !== null) {
        writeState(
          ctx.paths,
          { ...prev, blocked: true, blocked_reason: message, updated_at: ctx.now().toISOString() },
          `BLOCKED: ${message}`,
        );
        // refresh manifest hashes so this state write is not later seen as drift
        touchManifest(ctx.paths, () => {}, ctx.now);
      }
    }
  } catch {
    /* never let checkpoint persistence mask the original blocker */
  }
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
