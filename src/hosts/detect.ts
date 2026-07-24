import { nodeSpawner, type Spawner } from './spawn.js';

export interface HostAvailability {
  /** True only when the binary started and `--version` exited 0. Never faked. */
  available: boolean;
  /** The reported version string, or null when unavailable / unparseable. */
  version: string | null;
}

const VERSION_TIMEOUT_MS = 10_000;

/**
 * Probe a CLI by running `<bin> --version`. A spawn error (binary not on PATH)
 * or a non-zero exit yields `{ available: false }`. This is the honest gate the
 * live E2E and readiness checks use: no binary, no "available".
 */
async function probe(bin: string, cwd: string, spawner: Spawner): Promise<HostAvailability> {
  const res = await spawner({ command: bin, args: ['--version'], cwd, timeoutMs: VERSION_TIMEOUT_MS });
  if (res.spawnError || res.timedOut || res.code !== 0) return { available: false, version: null };
  const version = res.stdout.trim() || res.stderr.trim() || null;
  return { available: true, version };
}

export function detectClaudeCli(
  cwd: string = process.cwd(),
  bin = 'claude',
  spawner: Spawner = nodeSpawner,
): Promise<HostAvailability> {
  return probe(bin, cwd, spawner);
}

export function detectCodexCli(
  cwd: string = process.cwd(),
  bin = 'codex',
  spawner: Spawner = nodeSpawner,
): Promise<HostAvailability> {
  return probe(bin, cwd, spawner);
}
