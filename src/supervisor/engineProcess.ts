import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree, processGroupAlive } from './killTree.js';
import type {
  EngineExit,
  EngineProcessFactory,
  EngineProcessHandle,
  EngineStartContext,
} from './engineTypes.js';

export interface NodeEngineProcessFactoryOptions {
  command: string;
  args: string[];
  cwd: string;
  /**
   * Explicit allowlisted environment for the engine. When omitted, only PATH
   * and basic platform variables are inherited; operator secrets are not
   * copied wholesale into a new process.
   */
  env?: NodeJS.ProcessEnv;
  termination_timeout_ms?: number;
  stdio?: 'ignore' | 'inherit';
}

const PROCESS_POLL_MS = 10;

function minimalEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

class NodeEngineProcessHandle implements EngineProcessHandle {
  readonly pid: number | null;
  readonly process_group: number | null;
  readonly result: Promise<EngineExit>;

  constructor(
    child: ChildProcess,
    private readonly terminationTimeoutMs: number,
  ) {
    this.pid = child.pid ?? null;
    this.process_group = process.platform === 'win32' ? null : this.pid;
    this.result = new Promise<EngineExit>((resolve) => {
      let settled = false;
      const settle = (exit: EngineExit): void => {
        if (settled) return;
        settled = true;
        resolve(exit);
      };
      child.once('error', () => settle({ code: null, signal: null }));
      child.once('close', (code, signal) => settle({ code, signal }));
    });
  }

  isAlive(): boolean {
    // The leader may have exited while one of its descendants still holds the
    // process group. Group liveness, not the leader's close event, is the fact
    // that gates replacement.
    return processGroupAlive(this.pid);
  }

  private async waitForDeath(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!processGroupAlive(this.pid)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_POLL_MS));
    }
  }

  async terminate(mode: 'term' | 'kill'): Promise<boolean> {
    if (!processGroupAlive(this.pid)) return true;
    await killProcessTree(this.pid, { mode });
    return this.waitForDeath(this.terminationTimeoutMs);
  }
}

/**
 * Real detached engine launcher. Each generation owns a fresh process group;
 * termination therefore covers children and grandchildren as well.
 */
export class NodeEngineProcessFactory implements EngineProcessFactory {
  constructor(private readonly options: NodeEngineProcessFactoryOptions) {}

  async start(context: EngineStartContext): Promise<EngineProcessHandle> {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: {
        ...(this.options.env ?? minimalEnvironment()),
        RIJO_ENGINE_GENERATION: String(context.generation),
        RIJO_SUPERVISOR_OWNER_ID: context.owner_id,
      },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: this.options.stdio ?? 'ignore',
      windowsHide: true,
    });
    return new NodeEngineProcessHandle(child, this.options.termination_timeout_ms ?? 2_000);
  }
}
