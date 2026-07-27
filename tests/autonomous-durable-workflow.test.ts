import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RijoPaths } from '../src/core/paths.js';
import { ProgressBus, silentSink, type DurableProgressRecorder } from '../src/core/progress.js';
import {
  completed,
  createContext,
  withLock,
  type DurableRunBinding,
  type DurableWorkflowEngine,
  type WorkflowContext,
  type WorkflowOutcome,
} from '../src/workflows/shared.js';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { checkWorkflow } from '../src/workflows/check.js';
import { readManifest } from '../src/core/manifest.js';
import { cleanup, deps, tmpProject, writePlanFile } from './helpers.js';

class RecordingDurableEngine implements DurableWorkflowEngine, DurableProgressRecorder {
  readonly calls: string[] = [];
  readonly progress: Parameters<DurableProgressRecorder['recordProgress']>[0][] = [];
  readonly terminals: string[] = [];
  activePlanHash: string | null = null;
  runId = 'run-durable-1';

  async initialize(): Promise<void> {
    this.calls.push('initialize');
  }

  async recover(): Promise<void> {
    this.calls.push('recover');
  }

  async beginOrResumeRun(input: {
    requestedRunId: string;
    plan?: string;
    planHash?: string;
    next?: boolean;
    host?: string;
  }): Promise<DurableRunBinding> {
    this.calls.push(`begin:${input.planHash ?? 'active'}`);
    if (!input.planHash) {
      return { runId: this.runId, disposition: 'resumed', planHash: this.activePlanHash };
    }
    if (this.activePlanHash === null) {
      this.activePlanHash = input.planHash;
      return { runId: this.runId, disposition: 'created', planHash: input.planHash };
    }
    if (input.next) {
      return {
        runId: this.runId,
        disposition: 'plan_mismatch',
        planHash: input.planHash,
        existingPlanHash: this.activePlanHash,
      };
    }
    if (this.activePlanHash === input.planHash) {
      return { runId: this.runId, disposition: 'resumed', planHash: input.planHash };
    }
    return {
      runId: this.runId,
      disposition: 'plan_mismatch',
      planHash: input.planHash,
      existingPlanHash: this.activePlanHash,
    };
  }

  recordProgress(input: Parameters<DurableProgressRecorder['recordProgress']>[0]): void {
    this.progress.push(input);
  }

  async createCheckpoint(input: { reason: string; commit?: string | null }): Promise<void> {
    this.calls.push(`checkpoint:${input.reason}:${input.commit ?? 'none'}`);
  }

  async createSnapshot(input: { reason: string }): Promise<void> {
    this.calls.push(`snapshot:${input.reason}`);
  }

  async markTerminal(input: { status: 'READY' | 'NOT_READY' | 'BLOCKED'; reason: string }): Promise<void> {
    this.terminals.push(input.status);
    this.calls.push(`terminal:${input.status}`);
  }

  async flush(): Promise<void> {
    this.calls.push('flush');
  }

  async close(): Promise<void> {
    this.calls.push('close');
  }
}

describe('durable progress projection boundary', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) cleanup(root);
  });

  it('delegates the event and status projection without persisting secret values', async () => {
    const root = tmpProject('rijo-durable-progress-');
    roots.push(root);
    const paths = new RijoPaths(root);
    const engine = new RecordingDurableEngine();
    const bus = new ProgressBus(paths, 'provisional', silentSink, () => new Date('2026-07-27T12:00:00.000Z'));
    bus.attachDurable(engine, 'run-ledger');

    bus.emit(
      'attempt.failed',
      { status: 'blocked', message: 'Authorization: Bearer secret-value-123456789' },
      { password: 'customer-password-123', nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz012345' } },
    );
    // The SQLite implementation commits synchronously inside this call. The
    // bus must invoke it now, not defer the invocation to a microtask.
    expect(engine.progress).toHaveLength(1);
    await bus.flushDurable();

    expect(JSON.stringify(engine.progress[0])).not.toContain('customer-password-123');
    expect(JSON.stringify(engine.progress[0])).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(JSON.stringify(engine.progress[0])).not.toContain('secret-value-123456789');
    expect(engine.progress[0]!.runId).toBe('run-ledger');
    expect(fs.existsSync(paths.events)).toBe(false);
    expect(fs.existsSync(paths.status)).toBe(false);
  });
});

describe('durable workflow lifecycle', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) cleanup(root);
  });

  it('initializes, recovers, binds the run and closes inside withLock', async () => {
    const root = tmpProject('rijo-durable-lock-');
    roots.push(root);
    const engine = new RecordingDurableEngine();
    const ctx = createContext(root, { ...deps(root), durable: engine });

    const result = await withLock(
      ctx,
      async () => {
        expect(ctx.bus.runId).toBe(engine.runId);
        expect(ctx.durableRun?.disposition).toBe('created');
        return completed(ctx, 'created');
      },
      { run: { planHash: 'a'.repeat(64), next: false }, terminal: false },
    );

    expect(result.ok).toBe(true);
    expect(engine.calls.slice(0, 3)).toEqual(['initialize', 'recover', `begin:${'a'.repeat(64)}`]);
    expect(engine.calls.at(-2)).toBe('flush');
    expect(engine.calls.at(-1)).toBe('close');
  });

  it('closes a partially initialized durable engine before releasing the lock', async () => {
    const root = tmpProject('rijo-durable-init-failure-');
    roots.push(root);
    const engine = new RecordingDurableEngine();
    engine.initialize = async () => {
      engine.calls.push('initialize');
      throw new Error('driver initialization failed');
    };
    const ctx = createContext(root, { ...deps(root), durable: engine });

    await expect(withLock(ctx, async () => completed(ctx, 'unreachable'))).rejects.toThrow(
      'driver initialization failed',
    );

    expect(engine.calls).toEqual(['initialize', 'flush', 'close']);
    expect(fs.existsSync(ctx.paths.lock)).toBe(false);
  });

  it('resumes the same plan under --run without creating a duplicate milestone', async () => {
    const root = tmpProject('rijo-durable-resume-');
    roots.push(root);
    writePlanFile(root);
    const engine = new RecordingDurableEngine();
    const d = deps(root);
    const first = await newWorkflow(root, { planFile: '@PLANO.md' }, { ...d, durable: engine });
    expect(first.ok, first.message).toBe(true);
    const before = readManifest(new RijoPaths(root))!;

    let finalChecks = 0;
    const finalCheck = async (ctx: WorkflowContext): Promise<WorkflowOutcome> => {
      finalChecks++;
      return completed(ctx, 'Production readiness: READY.');
    };
    const resumed = await newWorkflow(
      root,
      { planFile: '@PLANO.md', run: true },
      { ...d, durable: engine, finalCheck },
    );

    expect(resumed.ok, resumed.message).toBe(true);
    expect(finalChecks).toBe(1);
    const after = readManifest(new RijoPaths(root))!;
    expect(after.milestones).toHaveLength(before.milestones.length);
    expect(after.active_milestone).toBe(before.active_milestone);
    expect(engine.terminals.at(-1)).toBe('READY');
  });

  it('requires --next when an existing active run has a different plan hash', async () => {
    const root = tmpProject('rijo-durable-plan-mismatch-');
    roots.push(root);
    writePlanFile(root);
    const engine = new RecordingDurableEngine();
    const d = deps(root);
    expect((await newWorkflow(root, { planFile: '@PLANO.md' }, { ...d, durable: engine })).ok).toBe(true);
    const before = readManifest(new RijoPaths(root))!;
    const progressBeforeMismatch = engine.progress.length;

    const nextWhileSameRunActive = await newWorkflow(
      root,
      { planFile: '@PLANO.md', next: true, run: true },
      { ...d, durable: engine },
    );
    expect(nextWhileSameRunActive.status).toBe('blocked');
    expect(nextWhileSameRunActive.message).toContain('terminal checkpoint');
    expect(readManifest(new RijoPaths(root))!.milestones).toHaveLength(before.milestones.length);
    expect(engine.progress).toHaveLength(progressBeforeMismatch);

    writePlanFile(root, 'NOVO-PLANO.md', '# Changed contract\n\nA genuinely new milestone.');

    const outcome = await newWorkflow(
      root,
      { planFile: '@NOVO-PLANO.md', run: true },
      { ...d, durable: engine },
    );

    expect(outcome.status).toBe('blocked');
    expect(`${outcome.message} ${(outcome.details ?? []).join(' ')}`).toContain('--next');
    expect(readManifest(new RijoPaths(root))!.milestones).toHaveLength(before.milestones.length);
    expect(engine.terminals).toEqual([]);
    expect(engine.progress).toHaveLength(progressBeforeMismatch);

    const nextWhileActive = await newWorkflow(
      root,
      { planFile: '@NOVO-PLANO.md', next: true, run: true },
      { ...d, durable: engine },
    );
    expect(nextWhileActive.status).toBe('blocked');
    expect(nextWhileActive.message).toContain('terminal checkpoint');
    expect(readManifest(new RijoPaths(root))!.milestones).toHaveLength(before.milestones.length);
    expect(engine.progress).toHaveLength(progressBeforeMismatch);
  });

  it('chains production --fix after all phases and records the terminal result', async () => {
    const root = tmpProject('rijo-durable-final-check-');
    roots.push(root);
    writePlanFile(root);
    const engine = new RecordingDurableEngine();
    const d = deps(root);
    expect((await newWorkflow(root, { planFile: '@PLANO.md' }, { ...d, durable: engine })).ok).toBe(true);
    const calls: Array<{ production?: boolean; fix?: boolean; lockPresent: boolean }> = [];
    const finalCheck = async (ctx: WorkflowContext, opts: { production?: boolean; fix?: boolean }): Promise<WorkflowOutcome> => {
      calls.push({ ...opts, lockPresent: fs.existsSync(ctx.paths.lock) });
      return completed(ctx, 'Production readiness: READY.');
    };

    const outcome = await runWorkflow(
      root,
      { target: 'all' },
      { ...d, durable: engine, finalCheck },
    );

    expect(outcome.ok, outcome.message).toBe(true);
    expect(calls).toEqual([{ production: true, fix: true, lockPresent: true }]);
    expect(engine.terminals.at(-1)).toBe('READY');
    expect(engine.calls.indexOf('terminal:READY')).toBeLessThan(engine.calls.indexOf('snapshot:terminal:READY'));
    expect(engine.calls.some((call) => call.startsWith('checkpoint:task:'))).toBe(true);
    expect(engine.calls.some((call) => call.startsWith('snapshot:phase:'))).toBe(true);
  });

  it('does not terminalize an active run for a standalone non-production diagnostic check', async () => {
    const root = tmpProject('rijo-durable-local-check-');
    roots.push(root);
    writePlanFile(root);
    const engine = new RecordingDurableEngine();
    const d = deps(root);
    expect((await newWorkflow(root, { planFile: '@PLANO.md' }, { ...d, durable: engine })).ok).toBe(true);

    await checkWorkflow(root, {}, { ...d, durable: engine });

    expect(engine.terminals).toEqual([]);
  });
});
