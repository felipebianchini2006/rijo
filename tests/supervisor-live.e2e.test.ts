import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { TaskStore } from '../src/supervisor/store.js';
import { ProcessController } from '../src/supervisor/processController.js';
import { detectClaudeCli } from '../src/hosts/detect.js';
import { extractAgentResult } from '../src/hosts/parse.js';
import { RijoPaths } from '../src/core/paths.js';
import { SupervisorConfigSchema } from '../src/core/schemas/index.js';
import type { AgentTask } from '../src/agents/protocol.js';

/**
 * LIVE Part-M E2E: a REAL Claude Code CLI attempt is deliberately terminated
 * mid-turn by the supervisor (hard deadline far below the host's minimum
 * response latency), proving on a real host: deterministic detection, real
 * cancellation (SIGTERM ladder on the real process), fenced/isolated old
 * attempts that apply nothing, fresh-workspace replacement, and BOUNDED
 * termination (EXHAUSTED → BLOCKED) — never an infinite loop. Receipts (ids,
 * timestamps, per-attempt events) land in task-events.jsonl without secrets.
 */

const LIVE = process.env['RIJO_LIVE_E2E'] === '1';
const claude = await detectClaudeCli();

function liveTask(id: string): AgentTask {
  return {
    id,
    role: 'researcher',
    tier: 'economical-research',
    objective: 'Run the shell command `sleep 120`, then answer.',
    canonical_files: [],
    code_files: [],
    write_scope: [],
    acceptance_criteria: [],
    verification_commands: [],
    return_format: 'JSON AgentResult',
    notes: '',
    workspace: null,
    canonical_baseline: null,
    attempt: null,
    expert_profiles: [],
  };
}

describe.runIf(LIVE && claude.available)('LIVE: supervisor terminates and replaces a real Claude Code attempt (bounded)', () => {
  it(
    'kills a real stalled turn, fences it, replaces once, and ends BLOCKED within budget',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-sup-live-'));
      const attemptDirs: string[] = [];
      const pids: number[] = [];
      try {
        const paths = new RijoPaths(root);
        const config = SupervisorConfigSchema.parse({
          heartbeat_interval_ms: 500,
          heartbeat_grace_ms: 30_000, // liveness stays green (process IS alive) —
          hard_timeout_ms: {
            // — the HARD deadline is what deliberately terminates the turn
            lead: 5_000, planner: 5_000, worker: 5_000, reviewer: 5_000, researcher: 5_000, qa: 5_000,
          },
          no_progress_timeout_ms: {
            lead: 30_000, planner: 30_000, worker: 30_000, reviewer: 30_000, researcher: 30_000, qa: 30_000,
          },
          cancel_grace_ms: 4_000,
          hard_kill_grace_ms: 2_000,
          max_replacements_per_task: 1,
          max_total_task_elapsed_ms: 60_000,
          replacement_backoff_ms: [200],
        });
        const controller = new ProcessController(
          {
            buildCommand: (task) => {
              // one FRESH working directory per attempt: isolation is provable
              const dir = fs.mkdtempSync(path.join(root, 'attempt-'));
              attemptDirs.push(dir);
              return {
                command: 'claude',
                args: [
                  '-p',
                  `${task.objective} After sleeping, create a file DONE.txt with content done.`,
                  '--output-format', 'json',
                  '--model', 'haiku',
                  '--allowedTools', 'Bash(sleep:*)',
                  '--permission-mode', 'acceptEdits',
                ],
                cwd: dir,
              };
            },
            parseResult: (task, exit) => extractAgentResult(exit.stdout, task.id),
            onSpawn: (pid) => {
              if (pid !== null) pids.push(pid);
            },
          },
          'claude-cli-live',
        );
        const supervisor = new Supervisor({ controller, config, paths });

        const started = Date.now();
        const result = await supervisor.superviseTask(liveTask('live-stall'), {
          prepareAttempt: () => ({ task: liveTask('live-stall'), dispose: () => {} }),
        });
        const elapsed = Date.now() - started;

        // BOUNDED: exhausted the (1-replacement) budget instead of looping
        expect(result.ok).toBe(false);
        expect(result.summary).toMatch(/BLOCKED/i);
        expect(elapsed).toBeLessThan(60_000);

        // the durable record proves detection → cancellation → replacement → exhaustion
        const store = new TaskStore(paths);
        const record = store.read('live-stall')!;
        expect(record.state).toBe('EXHAUSTED');
        expect(record.generation).toBe(2); // one real replacement happened
        expect(record.replacement_count).toBe(1);

        // receipts: per-attempt lifecycle events with ids and timestamps
        const events = fs.readFileSync(path.join(root, '.rijo', 'runtime', 'task-events.jsonl'), 'utf8');
        expect(events).toContain('CANCELLING');
        expect(events).toContain('REPLACING');
        expect(events).toContain('EXHAUSTED');

        // both REAL host attempts ran (two processes spawned) and are DEAD now
        expect(pids.length).toBe(2);
        for (const pid of pids) {
          expect(() => process.kill(pid, 0), `pid ${pid} must be dead`).toThrow();
        }

        // the terminated attempts applied NOTHING to their workspaces
        for (const dir of attemptDirs) {
          expect(fs.existsSync(path.join(dir, 'DONE.txt')), `no result artifact in ${dir}`).toBe(false);
        }
        // no secrets in the receipts
        expect(events).not.toMatch(/sk-|api[_-]?key|token=/i);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe.skipIf(LIVE)('LIVE supervisor e2e (skipped unless RIJO_LIVE_E2E=1)', () => {
  it('is intentionally skipped without RIJO_LIVE_E2E=1', () => {
    expect(LIVE).toBe(false);
  });
});
