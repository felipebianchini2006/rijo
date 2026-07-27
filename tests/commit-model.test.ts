import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { fixWorkflow } from '../src/workflows/fix.js';
import { SystemGit } from '../src/core/git.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { parseFrontmatter } from '../src/core/frontmatter.js';
import { tmpProject, cleanup, writePlanFile, deps, ok } from './helpers.js';

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

describe('commit and evidence model (real git repository)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(tmpProject('rijo-git-'));
    writePlanFile(root);
    initRepo(root);
  });
  afterEach(() => cleanup(root));

  it('C1 code commit has no self-hash; C2..seal contain only evidence metadata; tree ends clean', async () => {
    const d = { ...deps(root), git: new SystemGit() };
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);

    const log = git(root, ['log', '--pretty=%H %s']).split('\n');
    const c1Line = log.find((l) => l.includes('verified'))!;
    const c1 = c1Line.split(' ')[0]!;
    const c2Line = log.find((l) => l.includes('evidence for'))!;
    const c2 = c2Line.split(' ')[0]!;
    const sealLine = log.find((l) => l.includes('evidence sealed'))!;
    const seal = sealLine.split(' ')[0]!;

    // C1 contains the code and the phase state WITHOUT its own hash
    const verificationAtC1 = git(root, ['show', `${c1}:.rijo/milestones/M001-simple-store/phases/01-catalog/VERIFICATION.md`]);
    expect(verificationAtC1).toContain('tested_commit: null');
    const c1Files = git(root, ['show', '--name-only', '--pretty=format:', c1]).split('\n').filter(Boolean);
    expect(c1Files).toContain('src/a.ts');

    // C2 points at C1 and touches ONLY allowed evidence metadata
    const c2Files = git(root, ['show', '--name-only', '--pretty=format:', c2]).split('\n').filter(Boolean);
    const allowed = [
      '.rijo/milestones/M001-simple-store/phases/01-catalog/VERIFICATION.md',
      '.rijo/milestones/M001-simple-store/ROADMAP.md',
      '.rijo/STATE.md',
      '.rijo/manifest.json',
      '.rijo/MILESTONES.md',
      '.rijo/REQUIREMENTS.md',
      '.rijo/ROADMAP.md',
      '.rijo/events.jsonl',
    ];
    for (const f of c2Files) expect(allowed, `illegal evidence path ${f}`).toContain(f);
    const verificationAtC2 = git(root, ['show', `${c2}:.rijo/milestones/M001-simple-store/phases/01-catalog/VERIFICATION.md`]);
    expect(verificationAtC2).toContain(`tested_commit: ${c1}`);

    // seal commit records the evidence commit id, evidence paths only
    const sealFiles = git(root, ['show', '--name-only', '--pretty=format:', seal]).split('\n').filter(Boolean);
    for (const f of sealFiles) expect(allowed).toContain(f);
    const finalVerification = fs.readFileSync(
      path.join(milestoneDir(root), 'phases', '01-catalog', 'VERIFICATION.md'),
      'utf8',
    );
    const fm = parseFrontmatter<Record<string, unknown>>(finalVerification).data;
    expect(fm['tested_commit']).toBe(c1);
    expect(fm['evidence_commit']).toBe(c2);
    expect(fm['vcs']).toBe('git');

    // everything RIJO touched is committed (tree clean for those paths)
    const dirty = git(root, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean);
    const rijoDirty = dirty.filter((l) => l.includes('.rijo/') || l.includes('src/'));
    expect(rijoDirty).toEqual([]);
  });

  it('pre-existing user edits on a task path are an explicit conflict, never appropriated', async () => {
    // the user has an uncommitted src/a.ts BEFORE the phase runs
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// user work in progress\n');
    const d = { ...deps(root), git: new SystemGit() };
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(`${outcome.message} ${outcome.details?.join(' ')}`).toMatch(/pre-existing local changes/);
    // the user's file was not committed by RIJO
    const dirty = git(root, ['status', '--porcelain', '-uall']);
    expect(dirty).toContain('src/a.ts');
  });

  it('fix follows the same model: C1 fix commit, C2 evidence-only, verified range', async () => {
    const d = { ...deps(root), git: new SystemGit() };
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    d.runner
      .on(
        (t) => t.id.startsWith('fix-diagnose'),
        (t) => ok(t, { payload: { reproduced: true, reproduction_steps: 'run x', hypothesis: 'h', root_cause: 'off-by-one', escalate: false, escalate_reason: '' } }),
      )
      .on(
        (t) => t.id.startsWith('fix-repair'),
        (t) => {
          const base = t.workspace!.root;
          fs.mkdirSync(path.join(base, 'src'), { recursive: true });
          fs.writeFileSync(path.join(base, 'src', 'fixed.ts'), '// fix\n');
          return ok(t, {
            payload: {
              fixed: true, root_cause: 'off-by-one', change_summary: 'repair the limit', regression_test: 'tests/fixed.test.ts',
              regression_test_impossible_reason: null, verification_commands: ['npm test'], residual_risk: 'none',
            },
          });
        },
      );
    const outcome = await fixWorkflow(root, { description: 'list truncates the last item' }, d);
    expect(outcome.ok, outcome.message).toBe(true);

    const log = git(root, ['log', '--pretty=%H %s']).split('\n');
    const c1 = log.find((l) => l.includes('rijo(fix): list'))!.split(' ')[0]!;
    const c2 = log.find((l) => l.includes('rijo(fix): evidence for'))!.split(' ')[0]!;
    const c2Files = git(root, ['show', '--name-only', '--pretty=format:', c2]).split('\n').filter(Boolean);
    expect(c2Files).toHaveLength(1);
    expect(c2Files[0]).toMatch(/\.rijo\/fixes\/.*\.md$/);
    const record = fs.readFileSync(path.join(root, c2Files[0]!), 'utf8');
    expect(record).toContain(`tested_commit: ${c1}`);
    expect(record).toContain('vcs: git');
  });

  it('without VCS the record says vcs: disabled and never invents a hash', async () => {
    const noGitRoot = fs.realpathSync(tmpProject('rijo-nogit-'));
    try {
      writePlanFile(noGitRoot);
      const d = deps(noGitRoot);
      d.git.repo = false; // no repository at all
      d.git.init = () => false; // and initialization is unavailable (pure no-VCS mode)
      await newWorkflow(noGitRoot, { planFile: '@PLAN.md' }, d);
      const outcome = await runWorkflow(noGitRoot, {}, d);
      expect(outcome.ok, outcome.message).toBe(true);
      const verification = fs.readFileSync(
        path.join(milestoneDir(noGitRoot), 'phases', '01-catalog', 'VERIFICATION.md'),
        'utf8',
      );
      const fm = parseFrontmatter<Record<string, unknown>>(verification).data;
      expect(fm['vcs']).toBe('disabled');
      expect(fm['tested_commit']).toBeNull();
      expect(fm['evidence_commit']).toBeNull();
    } finally {
      cleanup(noGitRoot);
    }
  });
});
