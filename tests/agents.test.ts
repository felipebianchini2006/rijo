import { describe, expect, it } from 'vitest';
import {
  AgentTaskSchema,
  ScopeViolationError,
  enforceWriteScope,
  type AgentResult,
  type AgentTask,
} from '../src/agents/protocol.js';
import { FakeAgentRunner, UnboundAgentRunner, runBatch } from '../src/agents/runner.js';
import { renderBrief } from '../src/agents/prompts.js';
import { tierFor } from '../src/agents/roles.js';
import { ConfigSchema } from '../src/core/schemas/index.js';
import { ok } from './helpers.js';

function task(partial: Partial<AgentTask> & { id: string }): AgentTask {
  return AgentTaskSchema.parse({
    role: 'worker',
    objective: `objective for ${partial.id}`,
    return_format: 'one-line summary',
    ...partial,
  });
}

function result(t: AgentTask, files: string[]): AgentResult {
  return { task_id: t.id, ok: true, summary: 'done', files_written: files, payload: null, scope_requests: [] };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('enforceWriteScope', () => {
  it('throws ScopeViolationError when a result writes outside the scope', () => {
    const t = task({ id: 'T-scope', write_scope: ['src/a.ts', 'docs/**'] });
    expect(() => enforceWriteScope(t, result(t, ['src/evil.ts']))).toThrow(ScopeViolationError);
    expect(() => enforceWriteScope(t, result(t, ['src/a.ts', 'outside.md']))).toThrow(/outside\.md/);
  });

  it('passes for exact-file and dir/** glob scopes (including backslash paths)', () => {
    const t = task({ id: 'T-scope-ok', write_scope: ['src/a.ts', 'docs/**'] });
    expect(() => enforceWriteScope(t, result(t, ['src/a.ts']))).not.toThrow();
    expect(() => enforceWriteScope(t, result(t, ['docs/deep/nested/file.md']))).not.toThrow();
    expect(() => enforceWriteScope(t, result(t, ['docs\\windows\\style.md']))).not.toThrow();
  });
});

describe('runBatch', () => {
  it('with parallelism=false executes tasks sequentially in order (sequential fallback)', async () => {
    const runner = new FakeAgentRunner({ subagents: true, parallelism: false, browser: false });
    const completed: string[] = [];
    // first task is the slowest: parallel execution would complete it last
    const delays: Record<string, number> = { 'T-1': 40, 'T-2': 20, 'T-3': 1 };
    runner.on(
      () => true,
      async (t) => {
        await delay(delays[t.id] ?? 0);
        completed.push(t.id);
        return ok(t);
      },
    );

    const tasks = [task({ id: 'T-1' }), task({ id: 'T-2' }), task({ id: 'T-3' })];
    const results = await runBatch(runner, tasks, 4);

    expect(runner.executed.map((t) => t.id)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(completed).toEqual(['T-1', 'T-2', 'T-3']);
    expect(results.map((r) => r.task_id)).toEqual(['T-1', 'T-2', 'T-3']);
  });

  it('with parallelism=true and maxParallel=2 still returns all results in task order', async () => {
    const runner = new FakeAgentRunner({ subagents: true, parallelism: true, browser: false });
    const delays: Record<string, number> = { 'T-1': 30, 'T-2': 1, 'T-3': 20, 'T-4': 1 };
    runner.on(
      () => true,
      async (t) => {
        await delay(delays[t.id] ?? 0);
        return ok(t);
      },
    );

    const tasks = [task({ id: 'T-1' }), task({ id: 'T-2' }), task({ id: 'T-3' }), task({ id: 'T-4' })];
    const results = await runBatch(runner, tasks, 2);

    expect(results).toHaveLength(4);
    expect(results.map((r) => r.task_id)).toEqual(['T-1', 'T-2', 'T-3', 'T-4']);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe('renderBrief', () => {
  it('contains objective, write scope, acceptance, verification and return format sections', () => {
    const brief = renderBrief(
      task({
        id: 'T-brief',
        objective: 'Implement the catalog module',
        canonical_files: ['.rijo/RULES.md'],
        code_files: ['src/catalog.ts'],
        write_scope: ['src/catalog.ts', 'tests/catalog.test.ts'],
        acceptance_criteria: ['listing works', 'search works'],
        verification_commands: ['npm test'],
        notes: 'keep it small',
      }),
    );

    expect(brief).toContain('## Objective');
    expect(brief).toContain('Implement the catalog module');
    expect(brief).toContain('## Write scope (you may ONLY write these)');
    expect(brief).toContain('- src/catalog.ts');
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('- listing works');
    expect(brief).toContain('## Verification commands');
    expect(brief).toContain('- npm test');
    expect(brief).toContain('## Return format');
    expect(brief).toContain('one-line summary');
    expect(brief).toContain('## Notes');
  });
});

describe('model routing', () => {
  it('tierFor returns the remapped tier from config without core changes', () => {
    const config = ConfigSchema.parse({ models: { worker: 'my-custom-model' } });
    expect(tierFor(config, 'worker')).toBe('my-custom-model');
    // other roles keep their abstract defaults
    expect(tierFor(config, 'lead')).toBe('strongest');
    expect(tierFor(config, 'reviewer')).toBe('strongest-independent');
  });
});

describe('UnboundAgentRunner', () => {
  it('returns ok:false with a diagnostic summary and honest capabilities', async () => {
    const runner = new UnboundAgentRunner();
    expect(runner.capabilities).toEqual({ subagents: false, parallelism: false, browser: false });

    const r = await runner.runTask(task({ id: 'T-unbound' }));
    expect(r.ok).toBe(false);
    expect(r.task_id).toBe('T-unbound');
    expect(r.summary).toContain('No agent runtime bound');
  });
});
