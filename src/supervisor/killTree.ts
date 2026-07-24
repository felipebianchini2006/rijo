import { spawn } from 'node:child_process';

/**
 * Cross-platform whole-process-tree termination.
 *
 * A host CLI (claude/codex) routinely spawns children of its own (shells,
 * language servers, tool subprocesses). Killing only the top pid leaves those
 * grandchildren orphaned — they keep holding the workspace, ports and file
 * handles the supervisor believes it reclaimed. `killProcessTree` targets the
 * ENTIRE tree so cancellation is a real fact, not a partial one.
 *
 * POSIX: the child is spawned `detached:true`, making it the leader of a new
 * process group whose id equals its pid. Signalling the negative pid delivers
 * to the whole group (`kill(-pid, …)`). If the group is already gone we get
 * ESRCH; we then fall back to the individual pid so a lone survivor is still
 * hit, and treat a second ESRCH as "already dead" (a benign race).
 *   - mode 'term' → SIGTERM (or a caller-provided signal) to the group;
 *   - mode 'kill' → SIGKILL to the group.
 *
 * Windows: there are no POSIX signals and `child.kill()` does not reach the
 * tree, so BOTH modes shell out to `taskkill /PID <pid> /T /F` (structured
 * argv, never an interpolated shell string) and we await its exit for
 * confirmation. Windows has no graceful tree-terminate — /F is unconditional —
 * which is consistent with the platform-gated tests (a Windows child cannot
 * ignore termination, so the SIGKILL rung is unreachable and unnecessary).
 */

export interface KillTreeOptions {
  /** 'term' = graceful (POSIX SIGTERM); 'kill' = hard (POSIX SIGKILL). Windows: both are taskkill /T /F. */
  mode: 'term' | 'kill';
  /** POSIX only: exact signal to deliver in 'term' mode. Default SIGTERM. Ignored in 'kill' mode and on Windows. */
  signal?: NodeJS.Signals;
}

export interface KillTreeResult {
  /** True when a real signal / taskkill was issued at something still alive. */
  signalled: boolean;
  /** How the tree was reached: whole group, a single pid fallback, taskkill, or nothing to do. */
  method: 'group' | 'pid' | 'taskkill' | 'noop';
  detail?: string;
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function killPosix(pid: number, opts: KillTreeOptions): KillTreeResult {
  const sig: NodeJS.Signals = opts.mode === 'kill' ? 'SIGKILL' : (opts.signal ?? 'SIGTERM');

  const killIndividual = (): KillTreeResult => {
    try {
      process.kill(pid, sig);
      return { signalled: true, method: 'pid', detail: `${sig} → pid ${pid}` };
    } catch (err) {
      if (errno(err) === 'ESRCH') return { signalled: false, method: 'noop', detail: 'already dead' };
      // EPERM or anything else: we could not signal it; report honestly.
      return { signalled: false, method: 'noop', detail: `pid ${pid}: ${errno(err) ?? 'error'}` };
    }
  };

  try {
    // Negative pid → the whole process group (child was spawned detached).
    process.kill(-pid, sig);
    return { signalled: true, method: 'group', detail: `${sig} → group ${pid}` };
  } catch (err) {
    // No such group (leader already exited, or not a group leader): fall back
    // to the individual pid so a lone survivor is still terminated.
    if (errno(err) === 'ESRCH') return killIndividual();
    // EPERM/other on the group: still try the individual pid.
    return killIndividual();
  }
}

function killWindows(pid: number): Promise<KillTreeResult> {
  return new Promise<KillTreeResult>((resolve) => {
    // Structured argv (no shell interpolation). /T = tree, /F = force.
    const tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    tk.on('error', (err) => {
      resolve({ signalled: false, method: 'noop', detail: `taskkill spawn failed: ${errno(err) ?? String(err)}` });
    });
    tk.on('close', (code) => {
      // exit 0 = killed; 128 = process not found (already gone) — both are "tree is gone".
      resolve({ signalled: code === 0, method: 'taskkill', detail: `taskkill exit ${code}` });
    });
  });
}

/**
 * Terminate the whole tree rooted at `pid`. Never throws: a dead process, a
 * missing group and a taskkill spawn failure are all reported as data. A
 * null/undefined pid is a no-op (nothing was ever spawned).
 */
export async function killProcessTree(
  pid: number | null | undefined,
  opts: KillTreeOptions,
): Promise<KillTreeResult> {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) {
    return { signalled: false, method: 'noop', detail: 'no pid' };
  }
  if (process.platform === 'win32') return killWindows(pid);
  return killPosix(pid, opts);
}

/**
 * POSIX-only liveness probe for a whole process group: `kill(-pid, 0)` throws
 * ESRCH once the group is gone. Returns true while any member survives. On
 * Windows (no process groups) it falls back to probing the single pid.
 */
export function processGroupAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === 'win32') process.kill(pid, 0);
    else process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (errno(err) === 'EPERM') return true; // exists but not ours to signal
    return false;
  }
}
