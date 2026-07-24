import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { ProcessLaunch, RawExit } from '../hosts/processTypes.js';
import { killProcessTree } from './killTree.js';
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
}

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
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env ?? process.env,
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
      if (!proc.exited && proc.pid != null) void killProcessTree(proc.pid, { mode: 'kill' });
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    return {
      attempt_id: id,
      lease_id: task.attempt?.lease_id ?? 'lease',
      generation: task.attempt?.generation ?? 1,
      host: this.host,
      process_id: proc.pid,
      result,
    };
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

  async requestCancel(handle: HostAttemptHandle, _reason: string): Promise<CancelReceipt> {
    const p = this.procs.get(handle.attempt_id);
    if (!p) return { requested: false, acknowledged: false, detail: 'unknown attempt' };
    if (p.exited) return { requested: true, acknowledged: true, detail: 'already exited' };
    const sig = this.opts.cancelSignal ?? 'SIGTERM';
    // Graceful cancel delivered to the WHOLE group so children exit too.
    // A configured SIGKILL cancel signal maps to hard-kill mode.
    if (p.pid != null) void killProcessTree(p.pid, { mode: sig === 'SIGKILL' ? 'kill' : 'term', signal: sig });
    // Acknowledgement == the process actually exits. If it ignores the signal
    // this promise stays pending; the supervisor bounds the wait and escalates.
    return new Promise<CancelReceipt>((resolve) => {
      if (p.exited) resolve({ requested: true, acknowledged: true, detail: `${sig} then exit` });
      else p.closeWaiters.push(() => resolve({ requested: true, acknowledged: true, detail: `${sig} then exit` }));
    });
  }

  async forceTerminate(handle: HostAttemptHandle, _reason: string): Promise<TerminationReceipt> {
    const p = this.procs.get(handle.attempt_id);
    if (!p) return { terminated: false, method: 'not_supported', detail: 'unknown attempt' };
    if (p.exited) return { terminated: true, method: 'sigkill', detail: 'already exited' };
    // Hard terminate the whole tree.
    if (p.pid != null) void killProcessTree(p.pid, { mode: 'kill' });
    return new Promise<TerminationReceipt>((resolve) => {
      if (p.exited) resolve({ terminated: true, method: 'sigkill' });
      else p.closeWaiters.push(() => resolve({ terminated: true, method: 'sigkill' }));
    });
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

  async dispose(handle: HostAttemptHandle): Promise<void> {
    const p = this.procs.get(handle.attempt_id);
    if (!p) return;
    // Best-effort reclaim: SIGKILL the whole tree if anything survives.
    if (!p.exited && p.pid != null) void killProcessTree(p.pid, { mode: 'kill' });
  }
}
