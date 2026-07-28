import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { SystemGit } from '../src/core/git.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRoadmap, readRequirements } from '../src/core/roadmap.js';
import { readState } from '../src/core/state.js';
import { parseFrontmatter } from '../src/core/frontmatter.js';
import { validateStateIntegrity } from '../src/core/traceability.js';
import { tmpProject, cleanup, writePlanFile, deps } from './helpers.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return (r.stdout ?? '').trim();
}

function initRepo(root: string): void {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'rijo-test@example.com']);
  git(root, ['config', 'user.name', 'RIJO Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
}

function milestoneDir(root: string): string {
  const paths = new RijoPaths(root);
  const manifest = readManifest(paths)!;
  const m = manifest.milestones.find((x) => x.id === manifest.active_milestone)!;
  return paths.milestoneDir(m.id, m.slug);
}

/** Throw the first time the given finalization step fires (simulated crash). */
function crashAt(step: string) {
  return {
    afterStep: (s: string) => {
      if (s === step) throw new Error(`INJECTED-FINALIZE-CRASH at ${step}`);
    },
  };
}

/** Assert phase 01 ended fully DONE-and-committed, with a clean, marker-free tree. */
function expectPhase01Complete(root: string): void {
  const paths = new RijoPaths(root);
  const mdir = milestoneDir(root);

  // no finalize marker remains — removal is the completion signal
  expect(fs.existsSync(paths.finalize), 'finalize marker leaked').toBe(false);

  // roadmap DONE with a real commit; VERIFICATION tested+evidence recorded
  const roadmap = readRoadmap(path.join(mdir, 'ROADMAP.md'));
  const p01 = roadmap.phases.find((p) => p.id === '01')!;
  expect(p01.status).toBe('DONE');
  expect(p01.commit).toBeTruthy();

  const verification = fs.readFileSync(path.join(mdir, 'phases', '01-catalog', 'VERIFICATION.md'), 'utf8');
  const fm = parseFrontmatter<Record<string, unknown>>(verification).data;
  expect(fm['tested_commit'], 'tested_commit unset').toBe(p01.commit);
  expect(fm['evidence_commit'], 'evidence_commit unset').toBeTruthy();

  // the C1 code+state commit exists and carries the source, without a self-hash
  const c1 = p01.commit as string;
  const c1Files = git(root, ['show', '--name-only', '--pretty=format:', c1]).split('\n').filter(Boolean);
  expect(c1Files).toContain('src/a.ts');
  expect(c1Files).toContain('.rijo/milestones/M001-simple-store/phases/01-catalog/PLAN-CYCLE.json');
  const verAtC1 = git(root, ['show', `${c1}:.rijo/milestones/M001-simple-store/phases/01-catalog/VERIFICATION.md`]);
  expect(verAtC1).toContain('tested_commit: null');

  // requirement DONE with evidence
  const reqs = readRequirements(path.join(mdir, 'REQUIREMENTS.md'));
  const r1 = reqs.requirements.find((r) => r.phase === '01')!;
  expect(r1.status).toBe('DONE');
  expect(r1.evidence).toBeTruthy();

  // state checkpoint advanced and points at the commit
  const state = readState(paths)!;
  expect(state.stage).toBe('DONE');
  expect(state.last_commit).toBe(c1);
  expect(state.blocked).toBe(false);
  expect(state.blocked_reason).toBeNull();

  // the tree is clean for everything RIJO touched
  const dirty = git(root, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean);
  const rijoDirty = dirty.filter((l) => l.includes('.rijo/') || l.includes('src/'));
  expect(rijoDirty, `dirty: ${rijoDirty.join(' | ')}`).toEqual([]);

  // no integrity errors (no drift, no dangling DONE-without-evidence)
  const issues = validateStateIntegrity(paths).filter((i) => i.severity === 'error');
  expect(issues.map((i) => i.code)).toEqual([]);
}

// Every durable step the finalizer can crash at — the eight windows from the
// P0.7 brief: the two DONE-status writes and both sides of C1, C2 and the seal.
const STEPS = ['roadmap', 'state', 'before_c1', 'after_c1', 'before_c2', 'after_c2', 'before_seal', 'after_seal'];

describe('phase finalization crash safety (real git, fault injection at every commit window)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(tmpProject('rijo-final-'));
    writePlanFile(root);
    initRepo(root);
  });
  afterEach(() => cleanup(root));

  it('happy path: a full phase finalizes and leaves no marker', async () => {
    const d = { ...deps(root), git: new SystemGit() };
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, { target: '01' }, d);
    expect(outcome.ok, outcome.message).toBe(true);
    expectPhase01Complete(root);
  });

  for (const step of STEPS) {
    it(`crash at "${step}" → next execution resumes finalization; implementation is NOT re-run`, async () => {
      const paths = new RijoPaths(root);

      // 1) Drive phase 01 up to (and into) finalization, then crash.
      const dCrash = { ...deps(root), git: new SystemGit(), finalizeHooks: crashAt(step) };
      await newWorkflow(root, { planFile: '@PLAN.md' }, dCrash);
      await expect(runWorkflow(root, { target: '01' }, dCrash)).rejects.toThrow(/INJECTED-FINALIZE-CRASH/);

      // the crash happened DURING finalization: the marker is present and the
      // implementation (workers) already ran exactly once on this crashed run.
      expect(fs.existsSync(paths.finalize), `no marker after crash at ${step}`).toBe(true);
      const workersOnCrash = dCrash.runner.executed.filter((t) => t.id.startsWith('exec-01-')).length;
      expect(workersOnCrash).toBeGreaterThan(0);

      // 2) The next execution (fresh deps, no hooks) resumes and completes it.
      const dResume = { ...deps(root), git: new SystemGit() };
      const outcome = await runWorkflow(root, { target: '01' }, dResume);
      expect(outcome.ok, outcome.message).toBe(true);

      // implementation, verification and review were NOT re-run on resume — the
      // recovery path never dispatches an agent.
      expect(dResume.runner.executed.filter((t) => t.id.startsWith('exec-01-'))).toHaveLength(0);
      expect(dResume.runner.executed.filter((t) => t.id.startsWith('code-review-01'))).toHaveLength(0);
      expect(dResume.runner.executed.filter((t) => t.id.startsWith('spec-01'))).toHaveLength(0);

      expectPhase01Complete(root);

      // 3) Idempotency: resuming again changes only the canonical event journal.
      const headAfterResume = git(root, ['rev-parse', 'HEAD']);
      const dAgain = { ...deps(root), git: new SystemGit() };
      const again = await runWorkflow(root, { target: '01' }, dAgain);
      expect(again.ok, again.message).toBe(true);
      const headAfterNoop = git(root, ['rev-parse', 'HEAD']);
      expect(git(root, ['diff', '--name-only', headAfterResume, headAfterNoop])).toBe(
        '.rijo/events.jsonl',
      );
      expectPhase01Complete(root);
    });
  }

  it('resuming a crashed finalization never yields a DONE phase without its commits', async () => {
    // crash right after the ROADMAP flip (phase DONE on disk, nothing committed):
    // the marker must prevent the phase being treated as done until it commits.
    const paths = new RijoPaths(root);
    const dCrash = { ...deps(root), git: new SystemGit(), finalizeHooks: crashAt('roadmap') };
    await newWorkflow(root, { planFile: '@PLAN.md' }, dCrash);
    await expect(runWorkflow(root, { target: '01' }, dCrash)).rejects.toThrow(/INJECTED-FINALIZE-CRASH/);

    // On disk the roadmap already says DONE, but there is NO phase commit yet…
    const mdir = milestoneDir(root);
    expect(readRoadmap(path.join(mdir, 'ROADMAP.md')).phases.find((p) => p.id === '01')!.status).toBe('DONE');
    const commitsBefore = git(root, ['log', '--pretty=%s']).split('\n').filter((l) => l.includes('verified'));
    expect(commitsBefore).toHaveLength(0);
    // …and the marker is present, so the DONE status is not yet authoritative.
    expect(fs.existsSync(paths.finalize)).toBe(true);

    // The next run rolls the finalization forward to a committed DONE.
    const outcome = await runWorkflow(root, { target: '01' }, { ...deps(root), git: new SystemGit() });
    expect(outcome.ok, outcome.message).toBe(true);
    expectPhase01Complete(root);
  });
});

describe('phase finalization crash safety (no VCS)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-final-nogit-');
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('crash during the DONE flips is resumed without re-implementing (no commits involved)', async () => {
    const paths = new RijoPaths(root);
    const dCrash = deps(root);
    dCrash.git.repo = false;
    dCrash.git.init = () => false;
    (dCrash as { finalizeHooks?: unknown }).finalizeHooks = crashAt('state');
    await newWorkflow(root, { planFile: '@PLAN.md' }, dCrash);
    await expect(runWorkflow(root, { target: '01' }, dCrash)).rejects.toThrow(/INJECTED-FINALIZE-CRASH/);
    expect(fs.existsSync(paths.finalize)).toBe(true);

    const dResume = deps(root);
    dResume.git.repo = false;
    dResume.git.init = () => false;
    const outcome = await runWorkflow(root, { target: '01' }, dResume);
    expect(outcome.ok, outcome.message).toBe(true);

    // no re-implementation on resume
    expect(dResume.runner.executed.filter((t) => t.id.startsWith('exec-01-'))).toHaveLength(0);
    expect(fs.existsSync(paths.finalize)).toBe(false);

    const mdir = milestoneDir(root);
    expect(readRoadmap(path.join(mdir, 'ROADMAP.md')).phases.find((p) => p.id === '01')!.status).toBe('DONE');
    const verification = fs.readFileSync(path.join(mdir, 'phases', '01-catalog', 'VERIFICATION.md'), 'utf8');
    const fm = parseFrontmatter<Record<string, unknown>>(verification).data;
    expect(fm['vcs']).toBe('disabled');
    expect(fm['tested_commit']).toBeNull();
    const reqs = readRequirements(path.join(mdir, 'REQUIREMENTS.md'));
    expect(reqs.requirements.find((r) => r.phase === '01')!.status).toBe('DONE');
  });
});
