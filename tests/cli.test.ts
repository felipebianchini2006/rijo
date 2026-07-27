import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runCli } from '../src/cli/main.js';
import { newWorkflow } from '../src/workflows/new.js';
import { cleanup, deps, tmpProject, writePlanFile } from './helpers.js';

describe('runCli', () => {
  let root: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = tmpProject('rijo-cli-');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    cleanup(root);
  });

  function logged(): string {
    return log.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('--status --json on an uninitialized dir returns 0 and initialized:false', async () => {
    const code = await runCli(['--status', '--json'], {}, root);
    expect(code).toBe(0);
    const parsed = JSON.parse(logged());
    expect(parsed.initialized).toBe(false);
    expect(parsed.active_milestone).toBeNull();
    expect(parsed.milestones).toEqual([]);
  });

  it('unknown command returns 2', async () => {
    const code = await runCli(['frobnicate'], {}, root);
    expect(code).toBe(2);
    expect(error.mock.calls.join('\n')).toContain('unknown command');
  });

  it('rijo new without a plan file arg returns 2', async () => {
    const code = await runCli(['new'], {}, root);
    expect(code).toBe(2);
  });

  it('production CLI wiring opens the real durable SQLite engine without an injected test runtime', async () => {
    writePlanFile(root);

    // No fake runner/executor/deps: this is the same dependency path used by
    // the packaged CLI. The unbound planner fails, but durable startup must be
    // real and recoverable — never silently replaced with memory persistence.
    const code = await runCli(['new', '@PLANO.md'], {}, root);

    expect(code).toBe(1);
    expect(fs.existsSync(path.join(root, '.rijo', 'state', 'rijo.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.rijo', '.gitignore'))).toBe(true);
  });

  it('--version prints 0.1.0-alpha.1', async () => {
    const code = await runCli(['--version'], {}, root);
    expect(code).toBe(0);
    expect(logged().trim()).toBe('0.1.0-alpha.1');
  });

  it('--status --json after init is schema-stable', async () => {
    writePlanFile(root);
    const outcome = await newWorkflow(root, { planFile: 'PLANO.md' }, deps(root));
    expect(outcome.ok).toBe(true);

    log.mockClear();
    const code = await runCli(['--status', '--json'], {}, root);
    expect(code).toBe(0);

    const parsed = JSON.parse(logged());
    expect(Object.keys(parsed).sort()).toEqual(
      ['schema_version', 'rijo_version', 'initialized', 'active_milestone', 'milestones', 'runtime', 'checkpoint', 'supervisor', 'codebase'].sort(),
    );
    expect(parsed.schema_version).toBe(3);
    expect(parsed.rijo_version).toBe('0.1.0-alpha.1');
    expect(parsed.initialized).toBe(true);
    expect(parsed.active_milestone).toBe('M001');
    expect(Array.isArray(parsed.milestones)).toBe(true);
    expect(parsed.milestones.length).toBeGreaterThan(0);
    expect(parsed.milestones[0]).toMatchObject({ id: 'M001' });
    expect(parsed).toHaveProperty('runtime');
    expect(parsed).toHaveProperty('checkpoint');
  });

  it('supports map full, status, and zero-model query from the CLI', async () => {
    const source = `${root}/src/auth.ts`;
    fs.mkdirSync(`${root}/src`, { recursive: true });
    fs.writeFileSync(source, 'export const validateSession = () => true;\n');
    const d = deps(root);
    expect(await runCli(['map', '--full'], d, root)).toBe(0);
    log.mockClear();
    expect(await runCli(['map', '--status'], d, root)).toBe(0);
    expect(JSON.parse(logged())).toMatchObject({ status: 'COMPLETE', freshness: 'FRESH' });
    const calls = d.runner.executed.length;
    log.mockClear();
    expect(await runCli(['map', '--query', 'validateSession'], d, root)).toBe(0);
    const result = JSON.parse(logged());
    expect(result.model_calls).toBe(0);
    expect(result.matches.some((match: { path: string | null }) => match.path === 'src/auth.ts')).toBe(true);
    expect(d.runner.executed.length).toBe(calls);
  });
});
