import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      ['schema_version', 'rijo_version', 'initialized', 'active_milestone', 'milestones', 'runtime', 'checkpoint', 'supervisor'].sort(),
    );
    expect(parsed.schema_version).toBe(2);
    expect(parsed.rijo_version).toBe('0.1.0-alpha.1');
    expect(parsed.initialized).toBe(true);
    expect(parsed.active_milestone).toBe('M001');
    expect(Array.isArray(parsed.milestones)).toBe(true);
    expect(parsed.milestones.length).toBeGreaterThan(0);
    expect(parsed.milestones[0]).toMatchObject({ id: 'M001' });
    expect(parsed).toHaveProperty('runtime');
    expect(parsed).toHaveProperty('checkpoint');
  });
});
