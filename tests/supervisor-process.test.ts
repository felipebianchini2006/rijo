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
  type PreparedAttempt,
  type RawExit,
} from '../src/supervisor/index.js';

/**
 * These tests spawn REAL child processes (short node scripts) and prove the
 * supervisor's guarantees against genuinely misbehaving processes: freezing,
 * ignoring SIGTERM, answering after cancellation, and dying. Timeouts are real
 * but tiny.
 */

const unhandled: unknown[] = [];
const allPids: number[] = [];
let scriptDir: string;

const SCRIPTS = {
  // Runs forever, no SIGTERM handler → default SIGTERM terminates it.
  freeze: `process.stdout.write('running\\n'); setInterval(() => {}, 1000);`,
  // Installs a no-op SIGTERM handler → only SIGKILL can stop it.
  ignoreTerm: `process.on('SIGTERM', () => {}); process.stdout.write('ignoring\\n'); setInterval(() => {}, 1000);`,
  // On SIGTERM, prints a result and exits — a result that arrives AFTER cancel.
  lateRespond: `process.on('SIGTERM', () => { process.stdout.write(JSON.stringify({ summary: 'late answer' }) + '\\n', () => process.exit(0)); }); setInterval(() => {}, 1000);`,
  // Dies immediately with a non-zero code (pipe closes).
  die: `process.exit(1);`,
  // Well-behaved: prints a result and exits 0.
  good: `process.stdout.write(JSON.stringify({ summary: 'ok-replacement' }) + '\\n', () => process.exit(0));`,
};

function scriptPath(name: keyof typeof SCRIPTS): string {
  return path.join(scriptDir, `${name}.mjs`);
}

beforeAll(() => {
  process.on('unhandledRejection', (r) => unhandled.push(r));
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-sup-proc-'));
  for (const [name, body] of Object.entries(SCRIPTS)) {
    fs.writeFileSync(path.join(scriptDir, `${name}.mjs`), body, 'utf8');
  }
});

afterEach(() => {
  expect(unhandled).toEqual([]);
});

afterAll(() => {
  // No child process spawned by this suite may still be alive.
  const survivors = allPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  expect(survivors).toEqual([]);
});

function tmpPaths(): RijoPaths {
  return new RijoPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-sup-')));
}

function parseResult(task: AgentTask, exit: RawExit) {
  if (exit.code === 0) {
    const line = exit.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    let payload: unknown = null;
    let summary = exit.stdout.trim() || 'ok';
    try {
      payload = JSON.parse(line);
      summary = (payload as { summary?: string }).summary ?? summary;
    } catch {
      /* non-JSON output */
    }
    return {
      task_id: task.id,
      ok: true,
      summary,
      files_written: [],
      payload,
      scope_requests: [],
      workflow_epoch: task.attempt?.workflow_epoch ?? null,
      attempt_id: task.attempt?.attempt_id ?? null,
      generation: task.attempt?.generation ?? null,
      lease_id: task.attempt?.lease_id ?? null,
    };
  }
  return {
    task_id: task.id,
    ok: false,
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

function controllerFor(): ProcessController {
  return new ProcessController({
    buildCommand: (task) => ({ command: process.execPath, args: [task.code_files[0]!], cwd: scriptDir }),
    parseResult,
    onSpawn: (pid) => {
      if (pid != null) allPids.push(pid);
    },
  });
}

function makeTask(id: string, script: keyof typeof SCRIPTS): AgentTask {
  return AgentTaskSchema.parse({
    id,
    role: 'worker',
    objective: 'run a process',
    return_format: 'JSON',
    code_files: [scriptPath(script)],
    workspace: { id: `ws-${id}-g1`, root: scriptDir },
  });
}

function cfg(over: Partial<Record<string, unknown>> = {}): SupervisorConfig {
  return SupervisorConfigSchema.parse({
    heartbeat_interval_ms: 50,
    heartbeat_grace_ms: 150,
    cancel_grace_ms: 300,
    hard_kill_grace_ms: 400,
    hard_timeout_ms: { worker: 500 },
    no_progress_timeout_ms: { worker: 100_000 },
    max_replacements_per_task: 0,
    replacement_backoff_ms: [10],
    max_total_task_elapsed_ms: 60_000,
    ...over,
  });
}

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitDead(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isDead(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return isDead(pid);
}

describe('supervisor — real processes', () => {
  it('detects a frozen process and stops it with SIGTERM (acknowledged), then replaces it', async () => {
    const controller = controllerFor();
    const paths = tmpPaths();
    const supervisor = new Supervisor({ controller, config: cfg({ max_replacements_per_task: 1 }), paths, clock: new SystemClock() });
    const prepareAttempt = (generation: number): PreparedAttempt => ({
      task: makeTask('freeze-T01', 'good'),
      dispose() {},
    });
    const before = allPids.length;
    const r = await supervisor.superviseTask(makeTask('freeze-T01', 'freeze'), { prepareAttempt });
    const frozenPid = allPids[before]!;
    expect(await waitDead(frozenPid)).toBe(true);
    expect(r.ok).toBe(true); // replacement (good script) succeeded
    expect(r.generation).toBe(2);
    const events = new TaskStore(paths).readEvents('freeze-T01').map((e) => e.type);
    expect(events).not.toContain('force_terminated'); // SIGTERM was enough
  });

  // POSIX-only: on Windows there are no signals — child.kill('SIGTERM') is
  // TerminateProcess, so a child CANNOT ignore it and the SIGKILL rung of the
  // ladder is unreachable (and unnecessary): graceful cancel already
  // hard-terminates there. The ladder itself is covered by the fake-clock suite.
  it.runIf(process.platform !== 'win32')('SIGKILLs a process that ignores SIGTERM (forceTerminate proven)', async () => {
    const controller = controllerFor();
    const paths = tmpPaths();
    const supervisor = new Supervisor({ controller, config: cfg(), paths, clock: new SystemClock() });
    const before = allPids.length;
    const r = await supervisor.superviseTask(makeTask('ignore-T01', 'ignoreTerm'));
    const pid = allPids[before]!;
    expect(await waitDead(pid)).toBe(true);
    expect(r.ok).toBe(false); // BLOCKED (no replacements configured)
    const events = new TaskStore(paths).readEvents('ignore-T01');
    const forced = events.find((e) => e.type === 'force_terminated');
    expect(forced?.data['method']).toBe('sigkill');
  });

  it('discards a result that a process prints AFTER cancellation (late result)', async () => {
    const controller = controllerFor();
    const paths = tmpPaths();
    const supervisor = new Supervisor({ controller, config: cfg(), paths, clock: new SystemClock() });
    const before = allPids.length;
    const r = await supervisor.superviseTask(makeTask('late-T01', 'lateRespond'));
    const pid = allPids[before]!;
    expect(await waitDead(pid)).toBe(true);
    expect(r.ok).toBe(false); // the late answer must NOT become the outcome
    // give the late result a moment to be delivered and evaluated
    await new Promise((res) => setTimeout(res, 200));
    const stale = new TaskStore(paths).readEvents('late-T01').filter((e) => e.type === 'late_or_stale_result');
    expect(stale.length).toBeGreaterThan(0);
    expect(stale[0]!.data['disposition']).toBe('LATE_OR_STALE_RESULT');
  });

  it('detects a process that dies (pipe closed) and replaces it with a healthy one', async () => {
    const controller = controllerFor();
    const paths = tmpPaths();
    const supervisor = new Supervisor({ controller, config: cfg({ max_replacements_per_task: 1 }), paths, clock: new SystemClock() });
    const prepareAttempt = (): PreparedAttempt => ({ task: makeTask('die-T01', 'good'), dispose() {} });
    const before = allPids.length;
    const r = await supervisor.superviseTask(makeTask('die-T01', 'die'), { prepareAttempt });
    expect(r.ok).toBe(true);
    expect(r.generation).toBe(2);
    // both the dead first attempt and the healthy replacement were spawned
    expect(allPids.length).toBeGreaterThanOrEqual(before + 2);
    const rec = new TaskStore(paths).read('die-T01')!;
    expect(rec.state).toBe('SUCCEEDED');
  });
});
