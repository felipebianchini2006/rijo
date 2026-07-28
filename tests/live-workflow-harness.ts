import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

/**
 * Shared harness for the LIVE, full-workflow E2E tests (Scenarios A/B/C).
 *
 * These helpers pack the real tarball, install it into a pristine fixture,
 * seed a minimal deterministic RIJO project and drive the INSTALLED CLI binary
 * (node_modules/rijo/dist/cli/index.js) exactly as an operator would. Nothing
 * here fakes a model, a host or a result: every `rijo new`/`rijo run` spawns
 * the real installed CLI, which spawns the real host CLI. The only injected
 * seam (Scenario B) is a `claude` PATH shim that NEVER fabricates a model
 * result — see tests/workflow-live.e2e.test.ts for why that is legitimate.
 */

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface PackEntry {
  filename: string;
}

/** `npm pack --json` may be preceded by lifecycle noise; parse from the first '['. */
function parsePackJson(stdout: string): PackEntry[] {
  const start = stdout.indexOf('[');
  expect(start, 'npm pack produced no JSON array').toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as PackEntry[];
}

/**
 * Build + pack the repo into a tarball; returns its absolute path (prepack runs
 * tsc). The tarball `npm pack` writes into the package root is MOVED to a unique
 * temp path so two concurrent live suites (e.g. the Claude and Codex files) never
 * collide on the shared `rijo-<version>.tgz` name — one suite's afterAll cleanup
 * would otherwise delete the tarball the other is still installing.
 */
export function packTarball(): string {
  const out = execFileSync('npm', ['pack', '--json'], { cwd: packageRoot, encoding: 'utf8' });
  const [entry] = parsePackJson(out);
  expect(entry, 'npm pack returned no entry').toBeDefined();
  const packed = path.join(packageRoot, entry!.filename);
  expect(fs.existsSync(packed), `tarball missing at ${packed}`).toBe(true);
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-tgz-')), entry!.filename);
  fs.renameSync(packed, dest);
  return dest;
}

export interface Fixture {
  root: string;
  cliEntry: string;
}

/** The minimal, deterministic, cheap plan: one pure function plus a Node test. */
export const PLAN_CONTENT = [
  '# Plan — Tiny pure-function library',
  '',
  '## Objective',
  'A single, small deliverable: one Node.js (CommonJS) pure function `add(a, b)`',
  'that returns the numeric sum, covered by one Node built-in test. This is ONE',
  'phase of work. The project already has a package.json — do NOT modify it.',
  '',
  '## Requirements',
  '1. Pure function. Create the source file `src/add.js` exporting `add` via',
  '   `module.exports = { add }`, where `add(a, b)` returns `a + b` with no',
  '   side effects and no external dependencies.',
  '   Acceptance: `require("./src/add").add(2, 3) === 5`.',
  '2. Test. Create the test file `test/add.test.js` using the built-in',
  '   `node:test` and `node:assert/strict` modules, asserting `add(2, 3) === 5`',
  '   and `add(-1, 1) === 0`. The verification command is exactly `node --test`.',
  '   Acceptance: `node --test` exits 0.',
  '',
  'Both requirements belong to the SAME single phase. Each task writes only its',
  'own source/test file; the framework records evidence and runs `node --test`',
  'itself, so no task writes any EVIDENCE/report file, anything under `.rijo/`,',
  'or `package.json`.',
  '',
  '## Non-functional',
  '- No third-party dependencies; standard library only.',
  '',
  '## Out of scope',
  '- Any function other than `add`; build tooling; TypeScript.',
  '',
  '## Acceptance',
  '- `node --test` exits 0 with the add tests passing.',
  '',
].join('\n');

export const BROWNFIELD_MAP_PLAN_CONTENT = [
  '# Plan — Extend the existing counter safely',
  '',
  '## Objective',
  'Extend the existing `src/counter.mjs` public module in exactly two sequential phases.',
  'Preserve its current `current()` behavior and the existing Node test setup.',
  '',
  '## Requirements',
  '1. Phase 01 — increment. Add an exported `increment(value)` function that returns `value + 1`,',
  '   plus real `node:test` coverage. Acceptance: `increment(1) === 2` and the existing test stays green.',
  '2. Phase 02 — decrement. After phase 01, add an exported `decrement(value)` function that returns',
  '   `value - 1`, plus real `node:test` coverage. Acceptance: `decrement(1) === 0` and all tests pass.',
  '',
  '## Mandatory phase structure',
  '- Create exactly two phases in this order: 01 Increment, then 02 Decrement.',
  '- Phase 02 depends on phase 01. Do not merge the requirements into one phase.',
  '- Modify only `src/counter.mjs` and `test/counter.test.mjs`.',
  '- Verification command: `npm test`.',
  '',
  '## Out of scope',
  '- Dependencies, frameworks, build tooling, UI, network, storage, or other source files.',
  '',
].join('\n');

/**
 * Create a pristine fixture: fresh tmp dir, `npm init -y`, a package.json whose
 * only verification script is `node --test`, the installed tarball, a real git
 * repo with a local identity, a root .gitignore and the deterministic PLAN.md.
 * The RIJO config (`.rijo/config.yml`) is pre-seeded so `rijo new` runs on the
 * cheap all-haiku tiers from its very first (extraction) call.
 */
export function createFixture(tarball: string, prefix: string, configYaml: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  execFileSync('npm', ['init', '-y'], { cwd: root, encoding: 'utf8' });
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
  // Only a `test` script → detectProjectCommands yields exactly `npm run test`.
  pkg.scripts = { test: 'node --test' };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, encoding: 'utf8' },
  );
  execFileSync(
    'npm',
    ['install', tarball, '--no-save', '--package-lock=false', '--no-audit', '--no-fund'],
    { cwd: root, encoding: 'utf8' },
  );
  const cliEntry = path.join(root, 'node_modules', 'rijo', 'dist', 'cli', 'index.js');
  expect(fs.existsSync(cliEntry), `installed CLI missing at ${cliEntry}`).toBe(true);

  // Real git repo with a deterministic local identity (never touches global config).
  execFileSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'rijo-e2e@example.com'], { cwd: root, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.name', 'RIJO E2E'], { cwd: root, encoding: 'utf8' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root, encoding: 'utf8' });

  fs.writeFileSync(path.join(root, '.gitignore'), ['node_modules/', '*.tgz', ''].join('\n'));
  fs.writeFileSync(path.join(root, 'PLAN.md'), PLAN_CONTENT);
  execFileSync(
    'git',
    ['add', '.gitignore', 'PLAN.md', 'package.json', 'package-lock.json'],
    { cwd: root, encoding: 'utf8' },
  );
  execFileSync(
    'git',
    ['commit', '-m', 'test: seed clean client repository'],
    { cwd: root, encoding: 'utf8' },
  );

  fs.mkdirSync(path.join(root, '.rijo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rijo', 'config.yml'), configYaml);

  return { root, cliEntry };
}

/** A clean, committed brownfield fixture with real Git history and passing tests. */
export function createBrownfieldMapFixture(tarball: string, prefix: string, configYaml: string): Fixture {
  const fixture = createFixture(tarball, prefix, configYaml);
  fs.mkdirSync(path.join(fixture.root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(fixture.root, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.root, 'src', 'counter.mjs'),
    'export function current() { return 0; }\n',
  );
  fs.writeFileSync(
    path.join(fixture.root, 'test', 'counter.test.mjs'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { current } from '../src/counter.mjs';",
      "test('current baseline', () => assert.equal(current(), 0));",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(fixture.root, 'PLAN.md'), BROWNFIELD_MAP_PLAN_CONTENT);
  execFileSync('git', ['add', '-A'], { cwd: fixture.root, encoding: 'utf8' });
  execFileSync('git', ['commit', '-m', 'feat: seed brownfield counter with history'], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  execFileSync('npm', ['test'], { cwd: fixture.root, encoding: 'utf8' });
  return fixture;
}

/** Commit an external related change between phase 01 and the incremental remap. */
export function commitExternalCounterChange(fixture: Fixture): string {
  fs.appendFileSync(
    path.join(fixture.root, 'src', 'counter.mjs'),
    '\nexport const externalRevision = 2;\n',
  );
  execFileSync('git', ['add', 'src/counter.mjs'], { cwd: fixture.root, encoding: 'utf8' });
  execFileSync('git', ['commit', '-m', 'feat(counter): external related revision'], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim();
}

/** Prove phase 02 planned against the exact incrementally refreshed map commit. */
export function assertPhaseConsumedMap(fixture: Fixture, phase: string, mappedCommit: string): void {
  const eventsPath = path.join(fixture.root, '.rijo', 'events.jsonl');
  const events = fs
    .readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'run.map_context_fresh',
      data: expect.objectContaining({
        phase,
        mapped_commit: mappedCommit,
        last_operation: 'incremental',
      }),
    }),
  );
}

/**
 * Install a PATH shim that proxies every invocation to the real host except
 * tasks whose argv contains `taskMarker`. Those exit without emitting an
 * AgentResult, so the real workflow persists its approved plan and exercises
 * supervised failure/recovery without accepting any fabricated model output.
 */
export function writeFailingHostShim(
  shimDir: string,
  binaryName: 'claude' | 'codex',
  realBinary: string,
  taskMarker: string,
): void {
  const source = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const REAL = ${JSON.stringify(realBinary)};
const MARKER = ${JSON.stringify(taskMarker)};
const argv = process.argv.slice(2);
if (argv.join('\\n').includes(MARKER)) process.exit(86);
const result = spawnSync(REAL, argv, { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
`;
  const target = path.join(shimDir, binaryName);
  fs.writeFileSync(target, source, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}

/** (Re)write the fixture RIJO config, e.g. before `rijo run` to change supervisor policy. */
export function writeConfig(fixture: Fixture, configYaml: string): void {
  fs.writeFileSync(path.join(fixture.root, '.rijo', 'config.yml'), configYaml);
}

export interface SupervisorOverrides {
  /** Worker hard timeout (ms). Short in Scenario B so a stalled attempt is terminated fast. */
  workerHardTimeoutMs?: number;
  /** Researcher/mapper hard timeout (ms). Short only in live mapper replacement tests. */
  researcherHardTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  cancelGraceMs?: number;
  hardKillGraceMs?: number;
  maxReplacements?: number;
}

/**
 * Cost-minimal config with a generous happy-path supervisor policy.
 *
 * Tiers: the bulk-cost roles (worker, researcher, qa, lead) run on the cheapest
 * `economical-research` tier (haiku for Claude / gpt-5.6-luna for Codex). The
 * two roles that must emit STRICT structured JSON to drive the multi-agent
 * protocol — the planner and the reviewer (plan/code verdicts) — run
 * on `balanced-reasoning`: at the very cheapest tier those roles do not reliably
 * return a schema-valid verdict, so the phase cannot converge. This is still a
 * cost-minimal choice (a handful of reasoning-tier calls per phase; every write
 * worker stays cheapest), and it is the smallest tier bump that makes the real
 * end-to-end pipeline pass deterministically.
 *
 * `research.fail_closed` is false because this throwaway fixture makes NO
 * volatile stack decision to gate — a legitimate posture for the fixture, not a
 * way to smuggle an unverified production decision past the gate. Optional
 * supervisor overrides let Scenario B shorten only the worker deadline (every
 * other role keeps a generous deadline so real host turns are not cut).
 */
export function haikuConfigYaml(provider: 'claude' | 'codex', ov: SupervisorOverrides = {}): string {
  const workerHard = ov.workerHardTimeoutMs ?? 600_000;
  const researcherHard = ov.researcherHardTimeoutMs ?? 600_000;
  const heartbeat = ov.heartbeatIntervalMs ?? 3_000;
  const cancelGrace = ov.cancelGraceMs ?? 15_000;
  const hardKill = ov.hardKillGraceMs ?? 5_000;
  const maxRepl = ov.maxReplacements ?? 1;
  return [
    'schema_version: 4',
    'models:',
    '  lead: economical-research',
    '  reviewer: balanced-reasoning',
    '  planner: balanced-reasoning',
    '  worker: economical-research',
    '  researcher: economical-research',
    '  qa: economical-research',
    // Override the Claude tiers away from the production default (sonnet at HIGH
    // effort) so the live E2E fits its turn budget: the economical tiers use
    // haiku at low effort, and all six tiers are defined so nothing a workflow
    // references is missing. (Codex runs ignore this block and use the default
    // Codex tiers.)
    // The reasoning tier (planner/reviewer) runs sonnet at LOW effort: it keeps
    // each turn fast enough that the plan/review retry budgets fit inside the
    // live timeout, while the sharpened plan prompt ("every task writes a file")
    // and the blocker/critical-only review gate keep the structured protocol
    // converging. (Far cheaper/faster than the production high-effort default.)
    'providers:',
    '  claude:',
    '    strongest: {model: sonnet, effort: low}',
    '    strongest-independent: {model: sonnet, effort: low}',
    '    balanced-reasoning: {model: sonnet, effort: low}',
    '    economical-coding: {model: haiku, effort: low}',
    '    economical-research: {model: haiku, effort: low}',
    '    economical-browser: {model: haiku, effort: low}',
    'git:',
    '  commit: true',
    '  tag_milestones: false',
    'research:',
    '  fail_closed: false',
    'limits:',
    '  plan_revisions: 4',
    '  review_loops: 3',
    '  qa_fix_loops: 3',
    '  fix_attempts: 3',
    '  max_parallel_agents: 1',
    'host:',
    `  provider: ${provider}`,
    'supervisor:',
    `  heartbeat_interval_ms: ${heartbeat}`,
    '  heartbeat_grace_ms: 600000',
    '  hard_timeout_ms:',
    '    lead: 600000',
    '    planner: 600000',
    `    worker: ${workerHard}`,
    '    reviewer: 600000',
    `    researcher: ${researcherHard}`,
    '    qa: 600000',
    '  no_progress_timeout_ms:',
    '    lead: 600000',
    '    planner: 600000',
    '    worker: 600000',
    '    reviewer: 600000',
    '    researcher: 600000',
    '    qa: 600000',
    `  cancel_grace_ms: ${cancelGrace}`,
    `  hard_kill_grace_ms: ${hardKill}`,
    `  max_replacements_per_task: ${maxRepl}`,
    '  max_total_task_elapsed_ms: 1800000',
    '  replacement_backoff_ms: [500]',
    '',
  ].join('\n');
}

export interface RijoRun {
  status: number | null;
  stdout: string;
  stderr: string;
  combined: string;
}

/** Spawn the INSTALLED rijo CLI in the fixture; capture status + output. */
export function runRijo(
  fixture: Fixture,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): RijoRun {
  const res: SpawnSyncReturns<string> = spawnSync(process.execPath, [fixture.cliEntry, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: opts.timeoutMs ?? 780_000,
    maxBuffer: 64 * 1024 * 1024,
    env: opts.env ?? process.env,
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  return { status: res.status, stdout, stderr, combined: `${stdout}\n${stderr}` };
}

/** Read `rijo --status --json` from the fixture as a parsed object. */
export function readStatusJson(fixture: Fixture): {
  schema_version: number;
  supervisor: {
    tasks: Array<{ logical_task_id: string; role: string; state: string; generation: number; replacements: number }>;
  };
} {
  const res = runRijo(fixture, ['--status', '--json'], { timeoutMs: 30_000 });
  expect(res.status, `--status --json failed: ${res.combined}`).toBe(0);
  return JSON.parse(res.stdout);
}

/** Commit subjects, newest first, from the fixture repo. */
export function gitSubjects(fixture: Fixture): string[] {
  const out = execFileSync('git', ['log', '--format=%s'], { cwd: fixture.root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

/** Porcelain lines for TRACKED changes only (untracked '??' entries are ignored). */
export function trackedDirty(fixture: Fixture): string[] {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: fixture.root, encoding: 'utf8' });
  return out.split('\n').filter((l) => l.length > 0 && !l.startsWith('??'));
}

export function taskEventsPath(fixture: Fixture): string {
  return path.join(fixture.root, '.rijo', 'runtime', 'task-events.jsonl');
}

/** The single durable receipts file must never contain a leaked secret. */
export function assertNoSecrets(eventsText: string): void {
  expect(eventsText, 'secret pattern leaked into task-events.jsonl').not.toMatch(/sk-|api[_-]?key|token=/i);
}

/** True when host output signals capacity exhaustion (quota / rate / usage limit). */
export function quotaBlocked(text: string): boolean {
  return /usage limit|rate limit|quota|429|exceeded|insufficient_quota|too many requests/i.test(text);
}

/**
 * Shared Scenario-A assertions on a completed run (used by both the Claude and
 * Codex variants): phase finalized DONE with the C1/C2/seal commit chain, a
 * real source file produced and committed, a clean tracked tree, coherent
 * `--status --json`, and secret-free receipts.
 */
export function assertScenarioAOutcome(fixture: Fixture): void {
  const subjects = gitSubjects(fixture);
  // Baseline init commit + the transactional C1 (verified) / C2 (evidence) / seal chain.
  expect(subjects.some((s) => /milestone initialized/.test(s)), `no init commit in:\n${subjects.join('\n')}`).toBe(true);
  expect(subjects.some((s) => /F0\d.*verified/.test(s)), `no C1 verified commit in:\n${subjects.join('\n')}`).toBe(true);
  expect(subjects.some((s) => /evidence for/.test(s)), `no C2 evidence commit in:\n${subjects.join('\n')}`).toBe(true);
  expect(subjects.some((s) => /evidence sealed/.test(s)), `no seal commit in:\n${subjects.join('\n')}`).toBe(true);

  // The active milestone's roadmap must show every phase DONE.
  const milestonesDir = path.join(fixture.root, '.rijo', 'milestones');
  const mDirs = fs.readdirSync(milestonesDir);
  expect(mDirs.length, 'no milestone directory').toBeGreaterThan(0);
  const roadmap = fs.readFileSync(path.join(milestonesDir, mDirs[0]!, 'ROADMAP.md'), 'utf8');
  expect(roadmap).toMatch(/DONE/);
  expect(roadmap, `a phase is not DONE:\n${roadmap}`).not.toMatch(/PENDING|IN_PROGRESS|BLOCKED/);

  // A real committed source file exists (the worker produced code, not a stub).
  const tracked = execFileSync('git', ['ls-files'], { cwd: fixture.root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  expect(
    tracked.some((f) => /\.js$/.test(f) && !f.startsWith('.rijo/') && f !== '.gitignore'),
    `no committed source file among:\n${tracked.join('\n')}`,
  ).toBe(true);

  // The tree is clean w.r.t. tracked files, and nothing under .rijo/ is dirty.
  const dirty = trackedDirty(fixture);
  expect(dirty, `tracked tree not clean: ${dirty.join(', ')}`).toEqual([]);

  // `--status --json` is coherent: schema v3 and at least one SUCCEEDED task.
  const status = readStatusJson(fixture);
  expect(status.schema_version).toBe(3);
  const succeeded = status.supervisor.tasks.filter((t) => t.state === 'SUCCEEDED');
  expect(succeeded.length, `no SUCCEEDED supervised task in status: ${JSON.stringify(status.supervisor.tasks)}`).toBeGreaterThan(0);

  // Receipts exist and carry no secrets.
  const events = fs.readFileSync(taskEventsPath(fixture), 'utf8');
  assertNoSecrets(events);
}

export function rmFixture(fixture: Fixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
}
