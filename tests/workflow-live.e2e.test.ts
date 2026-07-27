import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectClaudeCli } from '../src/hosts/detect.js';
import {
  assertScenarioAOutcome,
  assertPhaseConsumedMap,
  commitExternalCounterChange,
  createBrownfieldMapFixture,
  createFixture,
  gitSubjects,
  haikuConfigYaml,
  packTarball,
  readStatusJson,
  rmFixture,
  runRijo,
  taskEventsPath,
  trackedDirty,
  assertNoSecrets,
} from './live-workflow-harness.js';

/**
 * LIVE, FULL-WORKFLOW E2E — not a driver ping. These tests pack the real
 * tarball, install it into a pristine fixture and drive the installed `rijo`
 * binary turnkey against the REAL Claude Code CLI end to end:
 * new → research → spec → plan → review → execute → verify → code-review →
 * transactional finalize (C1/C2/seal).
 *
 * GATED twice, exactly like tests/live-e2e.test.ts:
 *   1. RIJO_LIVE_E2E=1 (opt-in — real, paid model calls; haiku tiers keep it cheap);
 *   2. the Claude CLI must be genuinely detected on PATH.
 * When a gate is closed the test SKIPS EXPLICITLY (labelled), never silently.
 *
 *   RIJO_LIVE_E2E=1 npx vitest run tests/workflow-live.e2e.test.ts
 *
 * ── Why the Scenario B `claude` shim is legitimate ────────────────────────────
 * Scenario B proves the real resilience chain (stall → whole-tree kill → fresh
 * generation → completion) in the REAL pipeline. Determinism WITHOUT faking a
 * model result is achieved by a `claude` PATH shim that:
 *   • proxies every non-worker and every replacement invocation to the REAL
 *     `claude` binary (detection `--version`, spec, plan, review, and the
 *     generation-2 worker all run the real host and real model);
 *   • on ONLY the first execution-worker invocation, spawns a real child + real
 *     grandchild, records their pids, ignores SIGTERM and hangs FOREVER —
 *     printing NOTHING. It never emits a fabricated AgentResult. A hung host
 *     that answers nothing is indistinguishable from a genuinely wedged real
 *     host, which is exactly the failure the supervisor must survive. Every
 *     result the workflow actually ACCEPTS comes from the real Claude.
 */

const LIVE = process.env['RIJO_LIVE_E2E'] === '1';
const claude = LIVE ? await detectClaudeCli() : { available: false, version: null };
const TEST_TIMEOUT_MS = 1_200_000;

let tarball: string | null = null;

beforeAll(() => {
  if (LIVE && claude.available) tarball = packTarball();
});

afterAll(() => {
  if (tarball) fs.rmSync(tarball, { force: true });
});

/** Guard both gates with an explicit, labelled skip (never a silent skip). */
function gate(ctx: { skip: (note?: string) => void }): boolean {
  if (!LIVE) {
    ctx.skip('SKIPPED: set RIJO_LIVE_E2E=1 to run the live full-workflow E2E (real paid model calls).');
    return false;
  }
  if (!claude.available) {
    ctx.skip('SKIPPED: the Claude CLI is not detected on PATH (honest gate — nothing is faked).');
    return false;
  }
  return true;
}

describe('LIVE full-workflow E2E (Claude)', () => {
  it(
    'Scenario A — turnkey `rijo new --run` builds, verifies, reviews and finalizes a phase against the real host',
    async (ctx) => {
      if (!gate(ctx)) return;
      const fixture = createFixture(tarball!, 'rijo-wf-a-', haikuConfigYaml('claude'));
      try {
        // Single-shot turnkey: new → (research/spec/plan/review/execute/verify/
        // code-review) → transactional finalize, all against the real Claude.
        const run = runRijo(fixture, ['new', '@PLANO.md', '--host', 'claude', '--run'], { timeoutMs: TEST_TIMEOUT_MS - 60_000 });
        expect(run.status, `rijo new --run did not exit 0:\n${run.combined}`).toBe(0);

        assertScenarioAOutcome(fixture);
      } finally {
        rmFixture(fixture);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Scenario B — a real stalled generation is whole-tree killed and a fresh generation completes',
    async (ctx) => {
      if (!gate(ctx)) return;

      const realClaude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
      expect(realClaude, 'could not resolve the real claude binary').toBeTruthy();

      // Short worker deadline so the stalled generation-1 is terminated fast;
      // every other role keeps a generous deadline so real host turns finish.
      const configYaml = haikuConfigYaml('claude', {
        // The stalled gen-1 hangs forever, so any finite worker deadline
        // terminates it; keep it long enough that the REAL gen-2 worker turn
        // finishes comfortably inside the deadline.
        workerHardTimeoutMs: 45_000,
        heartbeatIntervalMs: 1_000,
        cancelGraceMs: 4_000,
        hardKillGraceMs: 2_000,
        maxReplacements: 1,
      });
      const fixture = createFixture(tarball!, 'rijo-wf-b-', configYaml);

      // Shim + its state directory (counter + recorded pids) live outside the fixture.
      const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-wf-b-shim-'));
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-wf-b-state-'));
      // The host env is a strict allowlist now (security hardening): custom
      // variables never reach a spawned host process. The shim therefore gets
      // its configuration BAKED IN as literals instead of via environment.
      writeClaudeShim(shimDir, realClaude, stateDir);

      try {
        // Single turnkey `new --run` (like Scenario A) with the `claude` shim
        // FIRST on PATH for the WHOLE run. A single process keeps our pre-seeded
        // config (short worker deadline) in memory — a separate `rijo run` would
        // read the default config `rijo new` rewrites on first init, and even
        // re-writing config.yml out-of-band trips the manifest drift guard. The
        // shim proxies every non-worker call (detection, extraction, spec, plan,
        // review) to the REAL claude and stalls only the first execution worker;
        // its replacement and every other call run the real host.
        const runEnv: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
        };
        const run = runRijo(fixture, ['new', '@PLANO.md', '--host', 'claude', '--run'], {
          env: runEnv,
          timeoutMs: TEST_TIMEOUT_MS - 120_000,
        });
        expect(run.status, `rijo new --run did not exit 0 after replacement:\n${run.combined}`).toBe(0);

        // ---- The stalled generation-1 process tree (shim + child + grandchild)
        // must be entirely dead: kill(pid, 0) throws ESRCH for each.
        const pids = readShimPids(stateDir);
        expect(pids.length, `expected 3 recorded pids (shim, child, grandchild), got ${pids.length}`).toBe(3);
        for (const pid of pids) {
          expect(() => process.kill(pid, 0), `pid ${pid} from the stalled gen-1 tree must be dead`).toThrow();
        }

        // ---- Receipts prove the chain: cancellation with a PROVEN dead group →
        // replacement → a generation-2 SUCCEEDED. Since the group-proof cancel,
        // a SIGTERM-ignoring child is SIGKILLed inside the graceful step itself
        // (audited in the cancel_receipt detail); the separate force_terminated
        // rung only fires when that in-step escalation could not confirm death.
        const events = fs.readFileSync(taskEventsPath(fixture), 'utf8');
        expect(events, 'no CANCELLING transition recorded').toContain('CANCELLING');
        const inStepGroupKill =
          events.includes('"cancel_receipt"') && events.includes('SIGKILL cleared the whole group');
        const separateForceRung = events.includes('force_terminated');
        expect(
          inStepGroupKill || separateForceRung,
          'no hard-kill evidence: neither a group-clearing cancel_receipt nor a force_terminated event was recorded',
        ).toBe(true);
        expect(events, 'no REPLACING transition recorded').toContain('REPLACING');
        assertNoSecrets(events);

        const status = readStatusJson(fixture);
        const replaced = status.supervisor.tasks.find(
          (t) => t.logical_task_id.startsWith('exec-') && t.generation === 2 && t.replacements === 1,
        );
        expect(replaced, `no exec task reached generation 2 SUCCEEDED: ${JSON.stringify(status.supervisor.tasks)}`).toBeDefined();
        expect(replaced!.state).toBe('SUCCEEDED');

        // ---- Only the generation-2 patch was applied: generation-1 produced
        // NOTHING (it hung), so the committed source is necessarily gen-2's, and
        // no attempt workspace survives.
        const wsDir = path.join(fixture.root, '.rijo', 'runtime', 'workspaces');
        const leftover = fs.existsSync(wsDir) ? fs.readdirSync(wsDir) : [];
        expect(leftover, `attempt workspaces leaked (gen-1 not discarded): ${leftover.join(', ')}`).toEqual([]);

        // ---- Phase finalized with the full commit chain, clean tree.
        const subjects = gitSubjects(fixture);
        expect(subjects.some((s) => /F0\d.*verified/.test(s)), `no C1 verified commit:\n${subjects.join('\n')}`).toBe(true);
        expect(subjects.some((s) => /evidence sealed/.test(s)), `no seal commit:\n${subjects.join('\n')}`).toBe(true);
        expect(trackedDirty(fixture), 'tracked tree not clean after run').toEqual([]);
      } finally {
        rmFixture(fixture);
        fs.rmSync(shimDir, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Scenario MAP — brownfield map, phase, external change, incremental remap, then fresh next phase',
    async (ctx) => {
      if (!gate(ctx)) return;
      const fixture = createBrownfieldMapFixture(tarball!, 'rijo-wf-map-claude-', haikuConfigYaml('claude'));
      try {
        const fullMap = runRijo(fixture, ['map', '--host', 'claude'], { timeoutMs: TEST_TIMEOUT_MS });
        expect(fullMap.status, `initial Claude map failed:\n${fullMap.combined}`).toBe(0);

        const created = runRijo(fixture, ['new', '@PLANO.md', '--host', 'claude'], { timeoutMs: TEST_TIMEOUT_MS });
        expect(created.status, `Claude new failed:\n${created.combined}`).toBe(0);

        const phaseOne = runRijo(fixture, ['run', '01', '--host', 'claude'], { timeoutMs: TEST_TIMEOUT_MS });
        expect(phaseOne.status, `Claude phase 01 failed:\n${phaseOne.combined}`).toBe(0);

        const externalCommit = commitExternalCounterChange(fixture);
        const incremental = runRijo(fixture, ['map', '--host', 'claude'], { timeoutMs: TEST_TIMEOUT_MS });
        expect(incremental.status, `Claude incremental map failed:\n${incremental.combined}`).toBe(0);
        const mapState = JSON.parse(
          fs.readFileSync(path.join(fixture.root, '.rijo', 'codebase', 'map-state.json'), 'utf8'),
        );
        expect(mapState.last_operation).toBe('incremental');
        expect(mapState.mapped_commit).toBe(externalCommit);
        expect(mapState.changed_paths_since_map).toContain('src/counter.mjs');

        const phaseTwo = runRijo(fixture, ['run', '02', '--host', 'claude'], { timeoutMs: TEST_TIMEOUT_MS });
        expect(phaseTwo.status, `Claude phase 02 failed:\n${phaseTwo.combined}`).toBe(0);
        const phaseTwoMapState = JSON.parse(
          fs.readFileSync(path.join(fixture.root, '.rijo', 'codebase', 'map-state.json'), 'utf8'),
        );
        expect(
          execFileSync(
            'git',
            ['merge-base', '--is-ancestor', externalCommit, phaseTwoMapState.mapped_commit],
            { cwd: fixture.root },
          ),
        ).toBeDefined();
        assertPhaseConsumedMap(fixture, '02', phaseTwoMapState.mapped_commit);
        execFileSync('npm', ['test'], { cwd: fixture.root, encoding: 'utf8' });
        expect(trackedDirty(fixture)).toEqual([]);
      } finally {
        rmFixture(fixture);
      }
    },
    2_400_000,
  );

  it(
    'Scenario MAP RECOVERY — a stalled mapper tree is killed and its real replacement promotes the map',
    async (ctx) => {
      if (!gate(ctx)) return;
      const realClaude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
      expect(realClaude, 'could not resolve the real claude binary').toBeTruthy();
      const fixture = createBrownfieldMapFixture(
        tarball!,
        'rijo-wf-map-recovery-',
        haikuConfigYaml('claude', {
          researcherHardTimeoutMs: 45_000,
          heartbeatIntervalMs: 1_000,
          cancelGraceMs: 4_000,
          hardKillGraceMs: 2_000,
          maxReplacements: 1,
        }),
      );
      const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-map-recovery-shim-'));
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-map-recovery-state-'));
      writeClaudeShim(shimDir, realClaude, stateDir, 'map-shard-');
      try {
        const run = runRijo(fixture, ['map', '--host', 'claude'], {
          env: {
            ...process.env,
            PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
          },
          timeoutMs: TEST_TIMEOUT_MS,
        });
        expect(run.status, `live mapper replacement failed:\n${run.combined}`).toBe(0);

        const pids = readShimPids(stateDir);
        expect(pids).toHaveLength(3);
        for (const pid of pids) {
          expect(() => process.kill(pid, 0), `stalled mapper pid ${pid} must be dead`).toThrow();
        }
        const status = readStatusJson(fixture);
        const replacement = status.supervisor.tasks.find(
          (task) => task.logical_task_id.startsWith('map-shard-') && task.generation === 2,
        );
        expect(replacement).toMatchObject({ state: 'SUCCEEDED', replacements: 1 });
        const mapState = JSON.parse(
          fs.readFileSync(path.join(fixture.root, '.rijo', 'codebase', 'map-state.json'), 'utf8'),
        );
        expect(mapState.status).toBe('COMPLETE');
        expect(trackedDirty(fixture)).toEqual([]);
      } finally {
        rmFixture(fixture);
        fs.rmSync(shimDir, { recursive: true, force: true });
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/** Recorded pids of the stalled generation-1 tree (shim, child, grandchild). */
function readShimPids(stateDir: string): number[] {
  const files = ['pid-shim', 'pid-child', 'pid-grandchild'];
  const pids: number[] = [];
  for (const f of files) {
    const p = path.join(stateDir, f);
    if (!fs.existsSync(p)) continue;
    const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    if (Number.isInteger(n) && n > 0) pids.push(n);
  }
  return pids;
}

/**
 * Write the deterministic `claude` PATH shim (an executable Node script). It
 * proxies to the real binary for everything except the FIRST execution-worker
 * invocation, which spawns a real child+grandchild, records pids, ignores
 * SIGTERM and hangs — never printing a fabricated result. See the file header
 * for why this is a legitimate, non-fabricating stall injector.
 */
function writeClaudeShim(
  shimDir: string,
  realClaude: string,
  stateDir: string,
  targetMarker = 'exec-',
): void {
  const shim = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

// Baked-in configuration: the supervised host process receives a minimal
// allowlisted environment, so the shim cannot rely on custom env vars.
const REAL = ${JSON.stringify(realClaude)};
const STATE = ${JSON.stringify(stateDir)};
const TARGET = ${JSON.stringify(targetMarker)};
const argv = process.argv.slice(2);
const joined = argv.join('\\n');

// Only the selected logical task family is fault-injected.
const isTarget = joined.indexOf(TARGET) !== -1;

function execReal() {
  const res = spawnSync(REAL, argv, { stdio: 'inherit' });
  process.exit(res.status == null ? 1 : res.status);
}

if (!isTarget) {
  // Detection (--version) and every non-target role: the REAL host runs.
  execReal();
}

// Count only target invocations. The FIRST one stalls; every later
// one (the generation-2 replacement, and any other task) runs the REAL host.
const counterFile = path.join(STATE, 'target-count');
let count = 0;
try { count = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch (e) {}
count += 1;
fs.writeFileSync(counterFile, String(count));

if (count !== 1) {
  execReal();
}

// ---- Generation-1 stall: real process tree that ignores SIGTERM and hangs.
// It prints NOTHING — no fabricated model result is ever produced.
const grandchildSrc =
  "process.on('SIGTERM',function(){});process.on('SIGINT',function(){});" +
  "require('fs').writeFileSync(process.env.PID_FILE, String(process.pid));" +
  "setInterval(function(){}, 1000000000);";
const childSrc =
  "process.on('SIGTERM',function(){});process.on('SIGINT',function(){});" +
  "var cp=require('child_process');" +
  "var gc=cp.spawn(process.execPath,['-e'," + JSON.stringify(grandchildSrc) + "]," +
  "{stdio:'ignore',env:Object.assign({},process.env,{PID_FILE:process.env.GC_PID_FILE})});" +
  "setInterval(function(){}, 1000000000);";

const child = spawn(process.execPath, ['-e', childSrc], {
  stdio: 'ignore',
  env: Object.assign({}, process.env, { GC_PID_FILE: path.join(STATE, 'pid-grandchild') }),
});
fs.writeFileSync(path.join(STATE, 'pid-child'), String(child.pid));
fs.writeFileSync(path.join(STATE, 'pid-shim'), String(process.pid));

process.on('SIGTERM', function () {});
process.on('SIGINT', function () {});
setInterval(function () {}, 1000000000);
`;
  const shimPath = path.join(shimDir, 'claude');
  fs.writeFileSync(shimPath, shim, { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);
}
