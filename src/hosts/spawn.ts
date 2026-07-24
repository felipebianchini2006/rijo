import { spawn } from 'node:child_process';

/**
 * A single external-process invocation. Drivers describe *what* to run; the
 * Spawner decides *how*. Injecting the Spawner keeps drivers fully
 * deterministic under test (no real process, no network, no model) while the
 * default implementation runs the real CLI.
 */
export interface SpawnRequest {
  command: string;
  args: string[];
  /** Working directory for the child. For RIJO this is the task workspace root. */
  cwd: string;
  /** Optional stdin payload. Closed immediately after writing. */
  input?: string;
  /** Hard wall-clock limit; the child is SIGKILLed when it elapses. */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnResult {
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /**
   * Set when the process could not be started at all (e.g. the binary is not
   * on PATH). Carries the OS error code such as 'ENOENT'. Never fabricated:
   * absence means the process genuinely started.
   */
  spawnError?: string;
}

export type Spawner = (req: SpawnRequest) => Promise<SpawnResult>;

/**
 * Real process spawner. Captures stdout/stderr, enforces the timeout with a
 * SIGKILL, and reports a spawn failure as data (never throws) so drivers can
 * turn "CLI not installed" into a precise AgentResult instead of crashing the
 * orchestrator.
 */
export const nodeSpawner: Spawner = (req) =>
  new Promise<SpawnResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, req.timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: stderr || String(err.message ?? err),
        timedOut,
        spawnError: err.code ?? 'SPAWN_ERROR',
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });

    if (req.input !== undefined) {
      child.stdin?.write(req.input);
    }
    child.stdin?.end();
  });
