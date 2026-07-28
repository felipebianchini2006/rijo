import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RijoPaths } from '../src/core/paths.js';
import { AgentTaskSchema, type AgentTask } from '../src/agents/protocol.js';
import { SupervisorConfigSchema, type SupervisorConfig } from '../src/core/schemas/index.js';
import {
  Supervisor,
  SystemClock,
  ProcessController,
  processGroupAlive,
  type RawExit,
} from '../src/supervisor/index.js';

/**
 * Proves P0.3: cancelling a supervised attempt kills the ENTIRE process tree
 * (parent → child → grandchild), not just the top pid. Each level of the tree
 * writes its pid to a file and then freezes forever; after the supervisor
 * cancels the attempt, NONE of the three pids may still exist.
 *
 * The child is spawned detached (new process group) by ProcessController, so a
 * group-directed signal reaches its descendants. Without whole-tree kill the
 * grandchild would be orphaned and survive.
 */

const unhandled: unknown[] = [];
const allPids: number[] = [];
let scriptDir: string;

/**
 * Tree node: record my pid, spawn one more level (non-detached → same group as
 * my detached ancestor), then freeze. `depth` counts down: 2 → parent, 1 →
 * child, 0 → grandchild.
 */
const TREE_SCRIPT = `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
const [pidDir, depthStr] = process.argv.slice(2);
const depth = Number(depthStr);
writeFileSync(pidDir + '/pid-' + depth, String(process.pid));
if (depth > 0) {
  spawn(process.execPath, [self, pidDir, String(depth - 1)], { stdio: 'ignore' });
}
setInterval(() => {}, 1000);
`;

beforeAll(() => {
  process.on('unhandledRejection', (r) => unhandled.push(r));
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-tree-'));
  fs.writeFileSync(path.join(scriptDir, 'tree.mjs'), TREE_SCRIPT, 'utf8');
});

afterEach(() => {
  expect(unhandled).toEqual([]);
});

afterAll(() => {
  // Nothing this suite spawned may still be alive.
  const survivors = allPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  // Best-effort reap any survivor before failing so the suite doesn't leak.
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  expect(survivors).toEqual([]);
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

function parseResult(task: AgentTask, exit: RawExit) {
  return {
    task_id: task.id,
    ok: exit.code === 0,
    summary: `exit ${exit.code ?? 'null'} signal ${exit.signal ?? 'null'}`,
    files_written: [],
    payload: null,
    scope_requests: [],
    workflow_epoch: task.attempt?.workflow_epoch ?? null,
    attempt_id: task.attempt?.attempt_id ?? null,
    generation: task.attempt?.generation ?? null,
    lease_id: task.attempt?.lease_id ?? null,
  };
}

function treeController(pidDir: string): ProcessController {
  return new ProcessController({
    buildCommand: (task) => ({
      command: process.execPath,
      args: [path.join(scriptDir, 'tree.mjs'), pidDir, '2'],
      cwd: scriptDir,
    }),
    parseResult,
    onSpawn: (pid) => {
      if (pid != null) allPids.push(pid);
    },
  });
}

function treeTask(id: string): AgentTask {
  return AgentTaskSchema.parse({
    id,
    role: 'worker',
    objective: 'spawn a process tree and freeze',
    return_format: 'JSON',
    workspace: { id: `ws-${id}-g1`, root: scriptDir },
  });
}

function cfg(): SupervisorConfig {
  return SupervisorConfigSchema.parse({
    heartbeat_interval_ms: 50,
    heartbeat_grace_ms: 150,
    cancel_grace_ms: 500,
    hard_kill_grace_ms: 500,
    // Large timeouts: the external abort — not a deadline — drives cancellation
    // so the whole tree is guaranteed to have spawned first.
    hard_timeout_ms: { worker: 60_000 },
    no_progress_timeout_ms: { worker: 60_000 },
    max_replacements_per_task: 0,
    replacement_backoff_ms: [10],
    max_total_task_elapsed_ms: 120_000,
  });
}

function tmpPaths(): RijoPaths {
  return new RijoPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-tree-sup-')));
}

function readPid(pidDir: string, name: string): number {
  return Number(fs.readFileSync(path.join(pidDir, name), 'utf8').trim());
}

async function waitUntil(pred: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

async function waitDead(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const start = Date.now();
  const dead = (): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  while (Date.now() - start < timeoutMs) {
    if (dead()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return dead();
}

describe('supervisor — whole process tree termination (P0.3)', () => {
  it('kills parent, child AND grandchild when the attempt is cancelled', async () => {
    const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-tree-pids-'));
    const controller = treeController(pidDir);
    const paths = tmpPaths();
    const supervisor = new Supervisor({ controller, config: cfg(), paths, clock: new SystemClock() });

    const ac = new AbortController();
    const supervisePromise = supervisor.superviseTask(treeTask('tree-T01'), { signal: ac.signal });

    // Wait for the FULL tree (3 levels) to come up before cancelling.
    const fullTree = await waitUntil(() =>
      ['pid-2', 'pid-1', 'pid-0'].every((n) => fs.existsSync(path.join(pidDir, n))),
    );
    expect(fullTree, 'the process tree never fully spawned').toBe(true);

    const parent = readPid(pidDir, 'pid-2');
    const child = readPid(pidDir, 'pid-1');
    const grandchild = readPid(pidDir, 'pid-0');
    for (const pid of [child, grandchild]) allPids.push(pid); // track for the leak check
    expect(new Set([parent, child, grandchild]).size).toBe(3);

    // Cancel via the supervisor and let it unwind.
    ac.abort();
    const r = await supervisePromise;
    expect(r.ok).toBe(false); // CANCELLED

    // NONE of the tree may survive — the grandchild is the real proof.
    expect(await waitDead(parent), `parent ${parent} survived`).toBe(true);
    expect(await waitDead(child), `child ${child} survived`).toBe(true);
    expect(await waitDead(grandchild), `grandchild ${grandchild} survived`).toBe(true);

    // POSIX: the process group itself is gone (kill(-pid,0) throws).
    if (process.platform !== 'win32') {
      expect(await waitUntil(() => !processGroupAlive(parent))).toBe(true);
    }

    fs.rmSync(pidDir, { recursive: true, force: true });
  }, 30_000);
});
