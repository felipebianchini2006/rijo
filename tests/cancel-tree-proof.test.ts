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
  TaskStore,
  processGroupAlive,
  type PreparedAttempt,
  type RawExit,
} from '../src/supervisor/index.js';

/**
 * Blocker 4: a cancellation is only complete when the whole tree is PROVEN
 * dead.
 *
 * The dangerous shape is a parent that is a good citizen and a descendant that
 * is not: the parent installs a SIGTERM handler and exits promptly, so the
 * controller sees its main process go away and used to report the cancel as
 * acknowledged — while a child and a grandchild that swallow SIGTERM keep
 * running, still holding the attempt's workspace and file handles. Here the
 * receipt may only come back acknowledged once `kill(pid, 0)` throws for the
 * parent, the child AND the grandchild, and the supervisor may only prepare a
 * replacement generation after that point.
 *
 * POSIX-only: Windows has no signals, so `child.kill('SIGTERM')` is
 * TerminateProcess and a child CANNOT ignore it; `taskkill /PID <pid> /T /F`
 * already reaps the tree synchronously there, which makes this scenario
 * unconstructible rather than untested.
 */

const posix = process.platform !== 'win32';

const unhandled: unknown[] = [];
const allPids: number[] = [];
let scriptDir: string;

/**
 * depth 2 → parent: HANDLES SIGTERM and exits cleanly (the polite process).
 * depth 1/0 → child and grandchild: install an EMPTY SIGTERM handler and keep
 * running forever (only SIGKILL stops them). Each level records its pid, then
 * spawns the next one in the SAME process group (non-detached).
 */
const SURVIVOR_TREE = `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
const [pidDir, depthStr] = process.argv.slice(2);
const depth = Number(depthStr);
if (depth > 0) {
  spawn(process.execPath, [self, pidDir, String(depth - 1)], { stdio: 'ignore' });
}
if (depth === 2) process.on('SIGTERM', () => process.exit(0));
else process.on('SIGTERM', () => {});
writeFileSync(pidDir + '/pid-' + depth, String(process.pid));
setInterval(() => {}, 1000);
`;

/** Healthy replacement: prints a result and exits 0. */
const GOOD = `process.stdout.write(JSON.stringify({ summary: 'ok-replacement' }) + '\\n', () => process.exit(0));`;

beforeAll(() => {
  process.on('unhandledRejection', (r) => unhandled.push(r));
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-cancelproof-'));
  fs.writeFileSync(path.join(scriptDir, 'survivor-tree.mjs'), SURVIVOR_TREE, 'utf8');
  fs.writeFileSync(path.join(scriptDir, 'good.mjs'), GOOD, 'utf8');
});

afterEach(() => {
  expect(unhandled).toEqual([]);
});

afterAll(() => {
  const survivors = allPids.filter(alive);
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseResult(task: AgentTask, exit: RawExit) {
  return {
    task_id: task.id,
    ok: exit.code === 0,
    summary: `exit ${exit.code ?? 'null'} signal ${exit.signal ?? 'null'}`,
    files_written: [],
    payload: null,
    scope_requests: [],
    attempt_id: null,
    generation: null,
    lease_id: null,
  };
}

/** Controller that runs whatever script the task names, with the pid dir as argv. */
function controllerFor(pidDir: string): ProcessController {
  return new ProcessController(
    {
      buildCommand: (task) => ({
        command: process.execPath,
        args: [task.code_files[0]!, pidDir, '2'],
        cwd: scriptDir,
      }),
      parseResult,
      // Short bound so the graceful rung of the ladder gives up quickly and the
      // SIGKILL escalation is exercised inside the supervisor's cancel grace.
      terminationTimeoutMs: 400,
      onSpawn: (pid) => {
        if (pid != null) allPids.push(pid);
      },
    },
    'survivor-tree-host',
  );
}

function taskFor(id: string, script: 'survivor-tree.mjs' | 'good.mjs'): AgentTask {
  return AgentTaskSchema.parse({
    id,
    role: 'worker',
    objective: 'spawn a tree whose descendants ignore SIGTERM',
    return_format: 'JSON',
    code_files: [path.join(scriptDir, script)],
    workspace: { id: `ws-${id}-g1`, root: scriptDir },
  });
}

function tmpPaths(): RijoPaths {
  return new RijoPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-cancelproof-sup-')));
}

async function waitUntil(pred: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

function treeUp(pidDir: string): boolean {
  return ['pid-2', 'pid-1', 'pid-0'].every((n) => fs.existsSync(path.join(pidDir, n)));
}

/** Read the three pids and register the descendants for the leak check. */
function treePids(pidDir: string): { parent: number; child: number; grandchild: number } {
  const read = (n: string): number => Number(fs.readFileSync(path.join(pidDir, n), 'utf8').trim());
  const pids = { parent: read('pid-2'), child: read('pid-1'), grandchild: read('pid-0') };
  allPids.push(pids.child, pids.grandchild);
  return pids;
}

describe.runIf(posix)('cancellation completes only with the whole tree proven dead (blocker 4)', () => {
  it('does not acknowledge while a SIGTERM-ignoring descendant of an exited parent survives', async () => {
    const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-cancelproof-pids-'));
    const controller = controllerFor(pidDir);
    const ac = new AbortController();
    const handle = await controller.start(
      { task: taskFor('cancelproof-T01', 'survivor-tree.mjs'), hard_deadline_at: new Date(Date.now() + 60_000).toISOString() },
      ac.signal,
    );
    handle.result.catch(() => undefined);

    expect(await waitUntil(() => treeUp(pidDir)), 'the process tree never fully spawned').toBe(true);
    const { parent, child, grandchild } = treePids(pidDir);
    expect(new Set([parent, child, grandchild]).size).toBe(3);
    // Precondition: the descendants really are alive when the cancel starts.
    expect([parent, child, grandchild].every(alive)).toBe(true);

    const receipt = await controller.requestCancel(handle, 'test cancel');

    // The instant the receipt resolves — before any further await — nothing of
    // the tree may be left. The parent exiting on SIGTERM is NOT the answer.
    const stillAlive = [parent, child, grandchild].filter(alive);
    expect(stillAlive, `survivors at acknowledgement: ${stillAlive.join(', ')}`).toEqual([]);
    expect(processGroupAlive(parent)).toBe(false);
    expect(receipt.requested).toBe(true);
    expect(receipt.acknowledged).toBe(true);
    // The graceful signal was NOT enough here: the detail must say so.
    expect(receipt.detail).toContain('SIGKILL');

    await controller.dispose(handle);
    fs.rmSync(pidDir, { recursive: true, force: true });
  }, 30_000);

  it('starts the replacement generation only after the previous tree is gone', async () => {
    const pidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-cancelproof-pids2-'));
    const controller = controllerFor(pidDir);
    const paths = tmpPaths();
    const config: SupervisorConfig = SupervisorConfigSchema.parse({
      heartbeat_interval_ms: 50,
      heartbeat_grace_ms: 300,
      // Generous graces: the cancellation ladder must be allowed to FINISH, so
      // that "replacement came second" is a fact about ordering and not about a
      // deadline firing.
      cancel_grace_ms: 5_000,
      hard_kill_grace_ms: 5_000,
      hard_timeout_ms: { worker: 60_000 },
      // Cancellation is triggered by progress going silent once the whole tree
      // is up (see onProgress below) — deterministic, not a race with startup.
      no_progress_timeout_ms: { worker: 500 },
      max_replacements_per_task: 1,
      replacement_backoff_ms: [10],
      max_total_task_elapsed_ms: 120_000,
    });
    const supervisor = new Supervisor({ controller, config, paths, clock: new SystemClock() });

    let pids: { parent: number; child: number; grandchild: number } | null = null;
    let aliveAtReplacement: number[] | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    const prepareAttempt = (generation: number): PreparedAttempt => {
      // Snapshot the tree's liveness at the exact moment the supervisor decides
      // to build the replacement attempt.
      aliveAtReplacement = pids ? [pids.parent, pids.child, pids.grandchild].filter(alive) : [-1];
      expect(generation).toBe(2);
      return { task: taskFor('cancelproof-T02', 'good.mjs'), dispose() {} };
    };

    try {
      const result = await supervisor.superviseTask(taskFor('cancelproof-T02', 'survivor-tree.mjs'), {
        prepareAttempt,
        onProgress: (emitProgress) => {
          // Keep the attempt "alive" until the full tree exists, then go silent
          // so the no-progress timeout cancels it.
          heartbeat = setInterval(() => {
            if (treeUp(pidDir)) {
              if (!pids) pids = treePids(pidDir);
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = null;
              return;
            }
            emitProgress();
          }, 80);
        },
      });

      expect(pids, 'the process tree never fully spawned').not.toBeNull();
      const tree = pids!;
      // The replacement was prepared, and at that moment NOTHING of the
      // previous tree was still running.
      expect(aliveAtReplacement, 'replacement prepared while the old tree was alive').toEqual([]);
      expect([tree.parent, tree.child, tree.grandchild].filter(alive)).toEqual([]);
      expect(processGroupAlive(tree.parent)).toBe(false);

      // The replacement itself ran and succeeded.
      expect(result.ok).toBe(true);
      expect(result.generation).toBe(2);
      const record = new TaskStore(paths).read('cancelproof-T02')!;
      expect(record.state).toBe('SUCCEEDED');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      fs.rmSync(pidDir, { recursive: true, force: true });
    }
  }, 60_000);
});
