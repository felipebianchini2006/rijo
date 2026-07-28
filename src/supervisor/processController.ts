import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { ProcessLaunch, RawExit } from '../hosts/processTypes.js';
import { buildHostEnv } from '../security/hostEnv.js';
import { killProcessTree, processGroupAlive } from './killTree.js';
import type {
  HostAgentController,
  HostAttemptHandle,
  HostLiveness,
  CancelReceipt,
  TerminationReceipt,
  HostAttemptStatus,
  SupervisedAgentTask,
} from '../hosts/controller.js';

/**
 * Generic process-backed controller. An attempt is a real child process:
 * liveness is `kill(pid, 0)`, graceful cancel is a signal (SIGTERM by default)
 * whose acknowledgement is the process actually exiting within the grace, and
 * hard termination is SIGKILL. Because the process is real, all of these are
 * facts — nothing is simulated. This is the controller used by the real-process
 * tests and the base for CLI-backed hosts.
 *
 * Every kill path (graceful cancel, hard terminate, abort, dispose) targets the
 * WHOLE process tree via killProcessTree, not just the top pid: the child is
 * spawned `detached:true` so it leads its own process group and any children it
 * spawned die with it. A partial kill that orphans grandchildren is not a
 * cancellation.
 *
 * Termination receipts are therefore GROUP facts, not parent facts. A parent
 * that politely handles SIGTERM and exits while a child of its own ignores the
 * signal is NOT a completed cancellation: the descendant still holds the
 * workspace, ports and file handles the supervisor believes it reclaimed.
 * `requestCancel`/`forceTerminate` only report success once
 * `processGroupAlive(pid)` is false, escalating to a group SIGKILL in between,
 * and `dispose` blocks on the same proof — so the supervisor can never start a
 * replacement generation while the previous tree is still running.
 *
 * The child environment is reconstructed from an allowlist
 * (security/hostEnv.ts). There is NO inherit-everything default: a launch
 * without an explicit env gets the minimal one, and the names (never the values)
 * of the withheld variables travel on the handle for auditing.
 */

// Re-exported from the shared module so existing importers (supervisor barrel,
// tests) keep working while the builders/parsers share the same vocabulary.
export type { ProcessLaunch, RawExit } from '../hosts/processTypes.js';

export interface ProcessControllerOptions {
  /** How to launch the child for a given task (argv is structured, never a shell string). */
  buildCommand: (task: AgentTask) => ProcessLaunch;
  /** How to turn the finished process's output into an AgentResult. */
  parseResult: (task: AgentTask, exit: RawExit) => AgentResult;
  /** Graceful-cancel signal. Default SIGTERM. */
  cancelSignal?: NodeJS.Signals;
  /** Observability hook fired right after a child is spawned (pid may be null on spawn failure). */
  onSpawn?: (pid: number | null, task: AgentTask) => void;
  /**
   * Host-auth variable names forwarded when `buildCommand` does not supply an
   * env of its own (see security/hostEnv.ts). Only used for that fallback.
   */
  hostEnvAllowlist?: readonly string[];
  /**
   * Bound, in ms, for each wait on the process GROUP dying (graceful, then after
   * the SIGKILL escalation). Default 2000. The supervisor bounds these calls
   * again with its own cancel/hard-kill graces.
   */
  terminationTimeoutMs?: number;
}

/** Default bound for each group-death wait. */
const DEFAULT_TERMINATION_TIMEOUT_MS = 2_000;
/** Poll interval while waiting for a process group to disappear. */
const GROUP_POLL_MS = 20;

interface Proc {
  child: ChildProcess;
  pid: number | null;
  exited: boolean;
  exit: RawExit | null;
  stdout: string;
  stderr: string;
  /** Resolvers waiting for the process to close (cancel/terminate receipts). */
  closeWaiters: Array<() => void>;
}

function stampIdentity(task: AgentTask, result: AgentResult): AgentResult {
  return {
    ...result,
    workflow_epoch: task.attempt?.workflow_epoch ?? result.workflow_epoch,
    attempt_id: task.attempt?.attempt_id ?? result.attempt_id,
    generation: task.attempt?.generation ?? result.generation,
    lease_id: task.attempt?.lease_id ?? result.lease_id,
  };
}

export class ProcessController implements HostAgentController {
  readonly host: string;
  private readonly procs = new Map<string, Proc>();

  constructor(
    private readonly opts: ProcessControllerOptions,
    host = 'process',
  ) {
    this.host = host;
  }

  async start(sup: SupervisedAgentTask, signal: AbortSignal): Promise<HostAttemptHandle> {
    const task = sup.task;
    const id = task.attempt?.attempt_id ?? task.id;
    const launch = this.opts.buildCommand(task);
    // NEVER `process.env`: a builder that supplies no env gets the minimal,
    // allowlisted one — the operator's secrets are not the host's to read.
    const fallback = launch.env ? null : buildHostEnv(this.opts.hostEnvAllowlist ?? []);
    const env = launch.env ?? fallback!.env;
    const envWithheld = launch.envWithheld ?? fallback?.withheld ?? [];
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // New process group so a kill reaches the whole tree (see killProcessTree).
      // On Windows this only detaches the console; the tree is reaped by taskkill /T.
      detached: process.platform !== 'win32',
    });
    const proc: Proc = {
      child,
      pid: child.pid ?? null,
      exited: false,
      exit: null,
      stdout: '',
      stderr: '',
      closeWaiters: [],
    };
    this.procs.set(id, proc);
    this.opts.onSpawn?.(proc.pid, task);

    child.stdout?.on('data', (d: Buffer) => {
      proc.stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      proc.stderr += d.toString('utf8');
    });

    const settle = (exit: RawExit): void => {
      if (proc.exited) return;
      proc.exited = true;
      proc.exit = exit;
      const waiters = proc.closeWaiters.splice(0);
      for (const w of waiters) w();
    };

    const result = new Promise<AgentResult>((resolve) => {
      child.on('error', (err: NodeJS.ErrnoException) => {
        settle({ code: null, signal: null, stdout: proc.stdout, stderr: proc.stderr || String(err.message ?? err) });
        resolve(stampIdentity(task, this.opts.parseResult(task, proc.exit!)));
      });
      child.on('close', (code, sig) => {
        settle({ code, signal: sig, stdout: proc.stdout, stderr: proc.stderr });
        resolve(stampIdentity(task, this.opts.parseResult(task, proc.exit!)));
      });
    });

    if (launch.input !== undefined) child.stdin?.write(launch.input);
    child.stdin?.end();

    const onAbort = (): void => {
      // Hard external stop: SIGKILL the whole tree (never just the top pid).
      // `proc.exited` is NOT the test — a descendant can outlive the main
      // process, so the GROUP is what decides whether there is anything to kill.
      if (proc.pid != null && processGroupAlive(proc.pid)) void killProcessTree(proc.pid, { mode: 'kill' });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    return {
      attempt_id: id,
      lease_id: task.attempt?.lease_id ?? 'lease',
      generation: task.attempt?.generation ?? 1,
      host: this.host,
      process_id: proc.pid,
      env_withheld: envWithheld,
      result,
    };
  }

  private get terminationTimeoutMs(): number {
    return this.opts.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
  }

  /**
   * Resolve true once NO member of the process group survives, false if the
   * bound elapses first. POSIX: `kill(-pid, 0)` throws ESRCH only when the last
   * member is gone, so this covers the main process AND every descendant it
   * spawned. Windows has no process groups — `processGroupAlive` probes the
   * single pid there, which is sufficient because `taskkill /T /F` already
   * reaped the tree synchronously.
   */
  private async awaitGroupDeath(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!processGroupAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, GROUP_POLL_MS);
      });
    }
  }

  async heartbeat(handle: HostAttemptHandle): Promise<HostLiveness> {
    const p = this.procs.get(handle.attempt_id);
    if (!p) return { alive: false, detail: 'unknown attempt' };
    if (p.exited) return { alive: false, detail: 'process exited' };
    if (p.pid == null) return { alive: false, detail: 'no pid' };
    try {
      process.kill(p.pid, 0);
      return { alive: true, detail: `pid ${p.pid} alive` };
    } catch {
      return { alive: false, detail: `pid ${p.pid} gone` };
    }
  }

  /**
   * Graceful cancel whose acknowledgement is the death of the WHOLE process
   * group — never merely the exit of the main process. The ladder is:
   *   1. deliver the cancel signal to the group;
   *   2. wait, bounded, for every member to disappear;
   *   3. if anything survives (a parent that honours SIGTERM but a child that
   *      ignores it), escalate to a group SIGKILL and wait again;
   *   4. acknowledge ONLY if the group is finally empty, otherwise report
   *      acknowledged:false with the surviving pid so the supervisor escalates
   *      to forceTerminate / fencing.
   */
  async requestCancel(handle: HostAttemptHandle, _reason: string): Promise<CancelReceipt> {
    const p = this.procs.get(handle.attempt_id);
    if (!p) return { requested: false, acknowledged: false, detail: 'unknown attempt' };
    const sig = this.opts.cancelSignal ?? 'SIGTERM';
    if (p.pid == null) {
      return p.exited
        ? { requested: true, acknowledged: true, detail: 'no pid; process already gone' }
        : { requested: false, acknowledged: false, detail: 'no pid to signal' };
    }
    const pid = p.pid;
    if (p.exited && !processGroupAlive(pid)) {
      return { requested: true, acknowledged: true, detail: 'already exited; group empty' };
    }

    // Graceful cancel delivered to the WHOLE group so children exit too.
    // A configured SIGKILL cancel signal maps to hard-kill mode.
    await killProcessTree(pid, { mode: sig === 'SIGKILL' ? 'kill' : 'term', signal: sig });
    if (await this.awaitGroupDeath(pid, this.terminationTimeoutMs)) {
      return { requested: true, acknowledged: true, detail: `${sig}: whole process group exited` };
    }

    // A descendant outlived the signal. The cancel is NOT done yet.
    await killProcessTree(pid, { mode: 'kill' });
    if (await this.awaitGroupDeath(pid, this.terminationTimeoutMs)) {
      return {
        requested: true,
        acknowledged: true,
        detail: `${sig} left survivors in group ${pid}; SIGKILL cleared the whole group`,
      };
    }
    return {
      requested: true,
      acknowledged: false,
      detail: `process group ${pid} still has live members after ${sig} and SIGKILL`,
    };
  }

  /**
   * Hard terminate. `terminated:true` is a group fact: SIGKILL the tree and
   * confirm the group is empty. A survivor (an unkillable D-state process, an
   * EPERM we cannot signal) is reported honestly as terminated:false so the
   * supervisor fences instead of believing a kill that did not happen.
   */
  async forceTerminate(handle: HostAttemptHandle, _reason: string): Promise<TerminationReceipt> {
    const p = this.procs.get(handle.attempt_id);
    if (!p) return { terminated: false, method: 'not_supported', detail: 'unknown attempt' };
    if (p.pid == null) {
      return p.exited
        ? { terminated: true, method: 'sigkill', detail: 'no pid; process already gone' }
        : { terminated: false, method: 'not_supported', detail: 'no pid to signal' };
    }
    const pid = p.pid;
    if (p.exited && !processGroupAlive(pid)) {
      return { terminated: true, method: 'sigkill', detail: 'already exited; group empty' };
    }
    await killProcessTree(pid, { mode: 'kill' });
    if (await this.awaitGroupDeath(pid, this.terminationTimeoutMs)) {
      return { terminated: true, method: 'sigkill', detail: `process group ${pid} eliminated` };
    }
    return { terminated: false, method: 'sigkill', detail: `process group ${pid} still alive after SIGKILL` };
  }

  async query(handle: HostAttemptHandle): Promise<HostAttemptStatus> {
    const p = this.procs.get(handle.attempt_id);
    if (!p) return { kind: 'unknown' };
    if (p.exited) return { kind: 'completed', detail: `exit ${p.exit?.code ?? 'signal'} ${p.exit?.signal ?? ''}`.trim() };
    if (p.pid == null) return { kind: 'unknown' };
    try {
      process.kill(p.pid, 0);
      return { kind: 'running' };
    } catch {
      return { kind: 'dead' };
    }
  }

  /**
   * Reclaim the attempt. This is the last barrier before the supervisor
   * prepares a REPLACEMENT generation, so it does not merely fire a signal: it
   * SIGKILLs anything still in the group and BLOCKS (bounded) until the group is
   * empty. A replacement therefore never starts while the previous tree still
   * holds the old workspace.
   */
  async dispose(handle: HostAttemptHandle): Promise<void> {
    const p = this.procs.get(handle.attempt_id);
    if (!p || p.pid == null) return;
    const pid = p.pid;
    if (!processGroupAlive(pid)) return;
    await killProcessTree(pid, { mode: 'kill' });
    await this.awaitGroupDeath(pid, this.terminationTimeoutMs);
  }
}
