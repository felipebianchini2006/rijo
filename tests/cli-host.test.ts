import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/main.js';
import { buildHostExecutor, resolveHostProvider, HOST_CAPABILITIES } from '../src/cli/host.js';
import { RijoPaths } from '../src/core/paths.js';
import { ConfigSchema } from '../src/core/schemas/index.js';
import type { Spawner } from '../src/hosts/spawn.js';
import { cleanup, tmpProject } from './helpers.js';

/** Spawner that reports a host CLI as present, echoing a version on `--version`. */
function availableSpawner(version: string): Spawner {
  return async () => ({
    code: 0,
    signal: null,
    stdout: version,
    stderr: '',
    timedOut: false,
  });
}

/** Spawner that reports the binary as missing (ENOENT), never faked available. */
const missingSpawner: Spawner = async () => ({
  code: null,
  signal: null,
  stdout: '',
  stderr: 'not found',
  timedOut: false,
  spawnError: 'ENOENT',
});

describe('resolveHostProvider (flag > config > none)', () => {
  it('returns the flag when valid, ignoring config', () => {
    const config = ConfigSchema.parse({ host: { provider: 'codex' } });
    expect(resolveHostProvider('claude', config)).toBe('claude');
  });

  it('falls back to config.host.provider when no flag is given', () => {
    expect(resolveHostProvider(undefined, ConfigSchema.parse({ host: { provider: 'codex' } }))).toBe('codex');
  });

  it("defaults to 'none' when neither flag nor config selects a host", () => {
    expect(resolveHostProvider(undefined, ConfigSchema.parse({}))).toBe('none');
  });

  it('reports an invalid flag as a usage error', () => {
    const r = resolveHostProvider('bogus', ConfigSchema.parse({}));
    expect(r).toEqual({ error: expect.stringContaining('Invalid --host') });
  });
});

describe('buildHostExecutor', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-host-');
  });
  afterEach(() => cleanup(root));

  it('mounts a Claude executor with the host capabilities when the CLI is present', async () => {
    const progress: string[] = [];
    const boot = await buildHostExecutor({
      provider: 'claude',
      projectRoot: root,
      config: ConfigSchema.parse({}),
      paths: new RijoPaths(root),
      spawner: availableSpawner('2.1.0 (Claude Code)'),
      onProgress: (l) => progress.push(l),
    });
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;
    expect(boot.host).toBe('claude');
    expect(boot.version).toBe('2.1.0 (Claude Code)');
    expect(boot.executor.capabilities).toEqual(HOST_CAPABILITIES);
    expect(progress.some((l) => l.includes('claude available'))).toBe(true);
    await boot.executor.dispose();
  });

  it('mounts a Codex executor with the host capabilities when the CLI is present', async () => {
    const boot = await buildHostExecutor({
      provider: 'codex',
      projectRoot: root,
      config: ConfigSchema.parse({}),
      paths: new RijoPaths(root),
      spawner: availableSpawner('codex-cli 0.9.0'),
    });
    expect(boot.ok).toBe(true);
    if (!boot.ok) return;
    expect(boot.host).toBe('codex');
    expect(boot.executor.capabilities).toEqual(HOST_CAPABILITIES);
    await boot.executor.dispose();
  });

  it('BLOCKS with a clear message when the CLI is missing (never simulated)', async () => {
    const boot = await buildHostExecutor({
      provider: 'claude',
      projectRoot: root,
      config: ConfigSchema.parse({}),
      paths: new RijoPaths(root),
      spawner: missingSpawner,
    });
    expect(boot.ok).toBe(false);
    if (boot.ok) return;
    expect(boot.message).toContain('unavailable');
    expect(boot.details.join(' ')).toContain('PATH');
  });
});

describe('runCli --host wiring', () => {
  let root: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let savedPath: string | undefined;

  beforeEach(() => {
    root = tmpProject('rijo-clihost-');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    log.mockRestore();
    error.mockRestore();
    cleanup(root);
  });

  function logged(): string {
    return log.mock.calls.map((c) => c.join(' ')).join('\n');
  }

  it('--host claude with no CLI on PATH BLOCKS with exit 3', async () => {
    // Empty PATH: `claude --version` cannot be resolved -> honest BLOCKED.
    process.env.PATH = tmpProject('rijo-emptypath-');
    const code = await runCli(['run', 'all', '--host', 'claude'], {}, root);
    expect(code).toBe(3);
    expect(logged()).toContain('unavailable');
  });

  it('an invalid --host value is a usage error (exit 2)', async () => {
    const code = await runCli(['run', 'all', '--host', 'bogus'], {}, root);
    expect(code).toBe(2);
    expect(error.mock.calls.join('\n')).toContain('Invalid --host');
  });

  it('no --host and provider none runs the workflow unchanged (no host coupling)', async () => {
    // Uninitialized project: the workflow itself decides the outcome, not the
    // host layer. This proves the host path is inert when provider is 'none'.
    const code = await runCli(['run', 'all'], {}, root);
    expect([0, 1, 3]).toContain(code);
    // never a host-availability message when no host was requested
    expect(logged()).not.toContain('unavailable');
  });
});

describe('config schema: host block is additive', () => {
  it("defaults host.provider to 'none' and keeps the current schema version", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.host.provider).toBe('none');
    expect(cfg.schema_version).toBe(4);
  });

  it('accepts an explicit provider without disturbing other sections', () => {
    const cfg = ConfigSchema.parse({ host: { provider: 'claude' } });
    expect(cfg.host.provider).toBe('claude');
    // existing sections still carry their defaults
    expect(cfg.supervisor.max_replacements_per_task).toBe(2);
    expect(cfg.models.worker).toBe('economical-coding');
  });
});
