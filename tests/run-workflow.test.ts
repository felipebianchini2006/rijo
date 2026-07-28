import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRequirements, readRoadmap } from '../src/core/roadmap.js';
import { readState } from '../src/core/state.js';
import { readPlan } from '../src/core/plan.js';
import { FakeShellRunner } from '../src/core/commands.js';
import { tmpProject, cleanup, writePlanFile, deps, ok, phaseReqIds, newMappedReference } from './helpers.js';

function milestoneDir(root: string): string {
  const paths = new RijoPaths(root);
  const manifest = readManifest(paths)!;
  const m = manifest.milestones.find((x) => x.id === manifest.active_milestone)!;
  return paths.milestoneDir(m.id, m.slug);
}

describe('rijo run', () => {
  let root: string;
  beforeEach(async () => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('runs a full phase through the state machine with evidence and commit', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);

    const mdir = milestoneDir(root);
    const phaseDir = path.join(mdir, 'phases', '01-catalog');
    for (const f of ['PLAN.md', 'SUMMARY.md', 'REVIEW.md', 'VERIFICATION.md']) {
      expect(fs.existsSync(path.join(phaseDir, f)), f).toBe(true);
    }
    expect(fs.existsSync(path.join(phaseDir, 'SPEC.md'))).toBe(false);
    expect(d.runner.executed.some((task) => task.id.startsWith('spec-'))).toBe(false);
    // evidence: commands with exit codes recorded
    const verification = fs.readFileSync(path.join(phaseDir, 'VERIFICATION.md'), 'utf8');
    expect(verification).toContain('echo test-a');
    expect(verification).toContain('exit 0');
    // roadmap updated with the implementation commit (a second metadata commit
    // syncs the hash cross-reference, so HEAD is the metadata commit)
    const roadmap = readRoadmap(path.join(mdir, 'ROADMAP.md'));
    expect(roadmap.phases[0]!.status).toBe('DONE');
    const implCommit = d.git.commits.find((c) => c.message.includes('verified'))!;
    expect(roadmap.phases[0]!.commit).toBe(implCommit.hash);
    // the phase commit staged only authorized files, never `git add -A`
    expect(implCommit.paths.length).toBeGreaterThan(0);
    expect(implCommit.paths.some((p) => p.includes('src/a.ts'))).toBe(true);
    // requirements of phase 01 done with evidence
    const reqs = readRequirements(path.join(mdir, 'REQUIREMENTS.md'));
    const r1 = reqs.requirements.find((r) => r.phase === '01')!;
    expect(r1.status).toBe('DONE');
    expect(r1.evidence).toBeTruthy();
    // state checkpoint advanced
    const state = readState(new RijoPaths(root))!;
    expect(state.stage).toBe('DONE');
    expect(state.last_commit).toBe(d.git.commits.find((c) => c.message.includes('verified'))!.hash);
    // workers ran with fresh briefs and strict scopes
    const workers = d.runner.executed.filter((t) => t.id.startsWith('exec-01-'));
    expect(workers).toHaveLength(3);
    expect(workers[0]!.write_scope).toEqual(['src/a.ts']);
    expect(workers[0]!.objective).toContain("local file-inspection and patch/edit tools");
    expect(workers[0]!.objective).toContain('Do NOT execute repository code');
    expect(workers[0]!.objective).toContain(
      'read its project-root copy as read-only context',
    );
    const planner = d.runner.executed.find((task) => task.id === 'plan-01-r0')!;
    expect(planner.objective).toContain('tests[] entry must be an executable verification command');
    expect(planner.return_format).toContain('executable command strings only');
    expect(planner.return_format).toContain('parent_module:"project-root"');
    expect(planner.return_format).toContain('package.json as the existing project-root bootstrap contract');
    const planReviewer = d.runner.executed.find((task) => task.id === 'plan-review-01-r0')!;
    expect(planReviewer.return_format).toContain('type MUST be exactly one of intent_gap|spec_gap');
    const codeReviewer = d.runner.executed.find((task) => task.id.startsWith('code-review-01-'))!;
    expect(codeReviewer.objective).toContain(
      'RIJO runs framework-owned UI smoke after this review.',
    );
    expect(codeReviewer.objective).toContain(
      'Do not reject only because that future smoke evidence is absent.',
    );
  });

  it('preserves but does not consume a legacy SPEC.md artifact', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const legacySpec = path.join(milestoneDir(root), 'phases', '01-catalog', 'SPEC.md');
    fs.mkdirSync(path.dirname(legacySpec), { recursive: true });
    fs.writeFileSync(legacySpec, '# Legacy phase specification\n', 'utf8');

    const outcome = await runWorkflow(root, {}, d);

    expect(outcome.ok, outcome.message).toBe(true);
    expect(fs.readFileSync(legacySpec, 'utf8')).toBe('# Legacy phase specification\n');
    expect(d.runner.executed.some((task) => task.id.startsWith('spec-'))).toBe(false);
    expect(
      d.runner.executed
        .filter((task) => task.id.startsWith('plan-') || task.id.startsWith('exec-') || task.id.startsWith('code-review-'))
        .every((task) => !task.canonical_files.includes(legacySpec)),
    ).toBe(true);
  });

  it('run all completes every phase respecting dependencies', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, { target: 'all' }, d);
    expect(outcome.ok).toBe(true);
    const roadmap = readRoadmap(path.join(milestoneDir(root), 'ROADMAP.md'));
    expect(roadmap.phases.every((p) => p.status === 'DONE')).toBe(true);
    // one commit per verified phase
    expect(d.git.commits.filter((c) => c.message.includes('verified'))).toHaveLength(2);
    expect(d.runner.executed.some((task) => task.id.startsWith('security-review-01-'))).toBe(false);
    expect(d.runner.executed.some((task) => task.id.startsWith('security-review-02-'))).toBe(true);
  });

  it('installs newly declared Node.js dependencies through the managed gate before verification', async () => {
    const d = deps(root, {
      planPayload: (phaseId) => {
        const requirementIds = phaseReqIds(root, phaseId);
        return {
          phase: phaseId,
          tasks: [
            {
              id: 'T01',
              name: 'Create the Node.js project manifest',
              requirement_ids: requirementIds,
              technical_justification: null,
              files: ['package.json'],
              mapped_references: [newMappedReference('package.json')],
              write_scope: ['package.json'],
              depends_on: [],
              parallel: false,
              tdd: false,
              tests: ['npm run typecheck'],
              evidence_expected: 'The type check exits with status 0.',
            },
            {
              id: 'T02',
              name: 'Add a typed source module',
              requirement_ids: [],
              technical_justification: 'The source module proves that the configured compiler can load project code.',
              files: ['src/a.ts'],
              mapped_references: [newMappedReference('src/a.ts')],
              write_scope: ['src/a.ts'],
              depends_on: ['T01'],
              parallel: false,
              tdd: false,
              tests: ['npm run typecheck'],
              evidence_expected: 'The source module passes the project type check.',
            },
          ],
        };
      },
    });
    d.runner.on(
      (task) => task.id === 'exec-01-T01',
      (task) => {
        const target = path.join(task.workspace!.root, 'package.json');
        fs.writeFileSync(target, JSON.stringify({
          name: 'managed-install-fixture',
          version: '1.0.0',
          private: true,
          scripts: { typecheck: 'tsc --noEmit' },
          devDependencies: { typescript: '^5.9.0' },
        }));
        return ok(task, {
          files_written: ['package.json'],
          payload: { done: true, notes: 'Created the manifest.' },
        });
      },
    );

    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);

    expect(outcome.ok, outcome.message).toBe(true);
    const installIndex = d.shell.calls.indexOf('npm install --no-audit --no-fund');
    const typecheckIndex = d.shell.calls.indexOf('npm run typecheck');
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(typecheckIndex).toBeGreaterThan(installIndex);
    expect(d.shell.callOptions[installIndex]).toMatchObject({
      cwd: root,
      allowInstall: true,
      timeoutMs: 10 * 60 * 1000,
    });
  });

  it('rejects an inconsistent plan (lint) and blocks after the revision limit', async () => {
    const d = deps(root, {
      planPayload: (phaseId) => ({
        phase: phaseId,
        tasks: [
          {
            id: 'T01', name: 'bad', requirement_ids: [], technical_justification: null,
            files: ['src/a.ts'], mapped_references: [{ path: 'src/a.ts', intent: 'new', parent_module: 'greenfield-root', placement_evidence: [{ path: '.', reason: 'fixture root' }] }], write_scope: ['src/a.ts'], depends_on: ['T99'],
            parallel: false, tdd: false, tests: [], evidence_expected: 'x', done: false,
          },
          {
            id: 'T02', name: 'bad2', requirement_ids: ['M001-REQ-999'], technical_justification: null,
            files: ['src/b.ts'], mapped_references: [{ path: 'src/b.ts', intent: 'new', parent_module: 'greenfield-root', placement_evidence: [{ path: '.', reason: 'fixture root' }] }], write_scope: ['src/b.ts'], depends_on: [],
            parallel: false, tdd: false, tests: [], evidence_expected: 'x', done: false,
          },
        ],
      }),
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.details?.join('\n')).toMatch(/MISSING_DEP|TASK_WITHOUT_REQ|UNKNOWN_REQ/);
  });

  it('blocks when the independent reviewer keeps rejecting the plan (bounded loop)', async () => {
    const d = deps(root, { reviewApproved: false });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('not approved after 2 revisions');
    // planner called initial + 2 revisions, never more
    const planners = d.runner.executed.filter((t) => t.id.startsWith('plan-01') && !t.id.startsWith('plan-review'));
    expect(planners.length).toBe(3);
  });

  it('revises a plan when an approved verdict still contains a high finding', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id.startsWith('plan-review-'),
      (t) =>
        ok(t, {
          payload: {
            approved: true,
            findings: [
              {
                type: 'test_gap',
                severity: 'high',
                description: 'The test command depends on missing setup.',
                file: null,
              },
            ],
          },
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('not approved after 2 revisions');
    expect(d.runner.executed.filter((t) => t.id.startsWith('plan-01-r')).length).toBe(3);
  });

  it('repairs a high code finding even when the reviewer sets approved', async () => {
    const d = deps(root);
    let reviews = 0;
    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) => {
        reviews++;
        return ok(t, {
          payload:
            reviews === 1
              ? {
                  approved: true,
                  findings: [
                    {
                      type: 'implementation_bug',
                      severity: 'high',
                      description: 'The implementation misses a required error path.',
                      file: 'src/a.ts',
                    },
                  ],
                }
              : { approved: true, findings: [] },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(d.runner.executed.some((t) => t.id.startsWith('review-fix-01-'))).toBe(true);
    expect(reviews).toBe(2);
  });

  it('returns a legacy spec_gap finding to phase planning', async () => {
    const d = deps(root);
    // override reviewer: approve plan reviews, flag spec_gap on code review
    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) => ok(t, { payload: { approved: false, findings: [{ type: 'spec_gap', severity: 'high', description: 'endpoint diverges from spec', file: null }] } }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('returning to planning');
    // phase must NOT be marked done
    const roadmap = readRoadmap(path.join(milestoneDir(root), 'ROADMAP.md'));
    expect(roadmap.phases[0]!.status).not.toBe('DONE');
  });

  it('records low-severity review uncertainty without manufacturing a technical blocker', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) =>
        ok(t, {
          payload: {
            approved: false,
            findings: [
              {
                type: 'spec_gap',
                severity: 'low',
                description: 'wording can be clarified without changing observable behavior',
                file: null,
              },
            ],
          },
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);
    const review = fs.readFileSync(
      path.join(milestoneDir(root), 'phases', '01-catalog', 'REVIEW.md'),
      'utf8',
    );
    expect(review).toContain('wording can be clarified');
  });

  it('resumes verified worker changes after a review block and commits the original source delta', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) =>
        ok(t, {
          payload: {
            approved: false,
            findings: [
              {
                type: 'spec_gap',
                severity: 'high',
                description: 'clarify the contract before finalization',
                file: null,
              },
            ],
          },
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const blockedRun = await runWorkflow(root, {}, d);
    expect(blockedRun.status).toBe('blocked');

    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) => ok(t, { payload: { approved: true, findings: [] } }),
    );
    const resumed = await runWorkflow(root, {}, d);
    expect(resumed.ok, resumed.message).toBe(true);
    const implementation = d.git.commits.find((commit) => commit.message.includes('verified'))!;
    expect(implementation.paths).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
  });

  it('blocks recovery when a task path changed after the isolated worker patch was applied', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) =>
        ok(t, {
          payload: {
            approved: false,
            findings: [
              {
                type: 'spec_gap',
                severity: 'high',
                description: 'hold finalization',
                file: null,
              },
            ],
          },
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    expect((await runWorkflow(root, {}, d)).status).toBe('blocked');
    fs.appendFileSync(path.join(root, 'src', 'a.ts'), '// concurrent user edit\n');

    const resumed = await runWorkflow(root, {}, d);
    expect(resumed.status).toBe('blocked');
    expect(resumed.message).toContain('changed after RIJO last controlled');
    expect(resumed.details?.join('\n')).toContain('src/a.ts');
  });

  it('verification failure does not advance state (atomicity) and bounded repair applies', async () => {
    const d = deps(root);
    // shell always fails for the plan's test command
    const failingShell = new FakeShellRunner([{ match: /echo test-a/, exitCode: 1, output: 'FAIL' }]);
    const d2 = { ...d, shell: failingShell };
    await newWorkflow(root, { planFile: '@PLAN.md' }, d2);
    const outcome = await runWorkflow(root, {}, d2);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('verification still failing');
    // repair workers were attempted exactly qa_fix_loops times
    const repairs = d.runner.executed.filter((t) => t.id.startsWith('verify-fix-'));
    expect(repairs).toHaveLength(2);
    // state not corrupted: no phase done, no requirement done
    const roadmap = readRoadmap(path.join(milestoneDir(root), 'ROADMAP.md'));
    expect(roadmap.phases[0]!.status).not.toBe('DONE');
    const reqs = readRequirements(path.join(milestoneDir(root), 'REQUIREMENTS.md'));
    expect(reqs.requirements.every((r) => r.status !== 'DONE')).toBe(true);
  });

  it('does not instruct a TDD worker to edit tests allocated outside its write scope', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, {}, d);
    const tddWorker = d.runner.executed.find((t) => t.id === 'exec-01-T01')!;
    expect(tddWorker.write_scope).toEqual(['src/a.ts']);
    expect(tddWorker.objective).toContain('Tests for this change are allocated to a separate task');
    expect(tddWorker.objective).not.toContain('write a failing test');
  });

  it('records a real RED command before a TDD implementation patch is applied', async () => {
    const calls: Array<{ cwd: string; exit: number }> = [];
    const redAwareShell = {
      run(command: string, options: { cwd?: string } = {}) {
        const cwd = options.cwd ?? root;
        const implemented = fs.existsSync(path.join(cwd, 'src', 'feature.mjs'));
        const exit = implemented ? 0 : 1;
        calls.push({ cwd, exit });
        return {
          command,
          exit_code: exit,
          summary: exit === 0 ? 'pass' : 'AssertionError: expected implemented behavior',
          duration_ms: 1,
          blocked: false,
          category: 'test' as const,
          sandbox: 'test-double',
          trust: 'repository-script',
          network: 'none',
        };
      },
    };
    const d = deps(root, {
      planPayload: (phaseId) => ({
        phase: phaseId,
        tasks: [
          {
            id: 'T01',
            name: 'Add tested behavior',
            requirement_ids: phaseReqIds(root, phaseId),
            technical_justification: null,
            files: ['src/feature.mjs', 'test/feature.test.mjs'],
            mapped_references: [
              newMappedReference('src/feature.mjs'),
              newMappedReference('test/feature.test.mjs'),
            ],
            write_scope: ['src/feature.mjs', 'test/feature.test.mjs'],
            depends_on: [],
            parallel: false,
            tdd: true,
            tests: ['node --test test/feature.test.mjs'],
            evidence_expected: 'The behavior test passes.',
            done: false,
          },
          {
            id: 'T02',
            name: 'Add integration marker',
            requirement_ids: [],
            technical_justification: 'The marker records integration.',
            files: ['src/integration.mjs'],
            mapped_references: [newMappedReference('src/integration.mjs')],
            write_scope: ['src/integration.mjs'],
            depends_on: ['T01'],
            parallel: false,
            tdd: false,
            tests: [],
            evidence_expected: 'The integration marker exists.',
            done: false,
          },
        ],
      }),
    });
    const wired = { ...d, shell: redAwareShell };
    await newWorkflow(root, { planFile: '@PLAN.md' }, wired);
    const outcome = await runWorkflow(root, {}, wired);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(calls.map((call) => call.exit)).toEqual([1, 0]);
    expect(calls[0]!.cwd).toContain('.rijo/runtime/workspaces/ws-tdd-red-01-T01-');
    const verification = fs.readFileSync(
      path.join(milestoneDir(root), 'phases', '01-catalog', 'VERIFICATION.md'),
      'utf8',
    );
    expect(verification).toContain('## TDD RED evidence');
    expect(verification).toContain('expected RED exit 1');
  });

  it('resumes from the last verified checkpoint without repeating work', async () => {
    const d = deps(root);
    // T02 worker fails on the first run
    let failT02 = true;
    d.runner.on(
      (t) => t.id === 'exec-01-T02' && failT02,
      (t) => ({ task_id: t.id, ok: false, summary: 'interrupted', files_written: [], payload: null, scope_requests: [] }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const first = await runWorkflow(root, {}, d);
    expect(first.status).toBe('blocked');
    // T01's patch was applied but the phase never verified: the plan shows the
    // partial implementation WITHOUT promoting it to done.
    const planPath = path.join(milestoneDir(root), 'phases', '01-catalog', 'PLAN.md');
    const t01AfterFirst = readPlan(planPath).tasks.find((t) => t.id === 'T01')!;
    expect(t01AfterFirst.status).toBe('IMPLEMENTED');
    expect(t01AfterFirst.done).toBe(false);
    // the failed T02 attempt left no trace in the checkout
    expect(fs.existsSync(path.join(root, 'src', 'b.ts'))).toBe(false);

    const execCountAfterFirst = d.runner.executed.filter((t) => t.id === 'exec-01-T01').length;
    failT02 = false;
    const second = await runWorkflow(root, {}, d);
    expect(second.ok, second.message).toBe(true);
    // T01 was NOT re-executed on resume (it was re-VERIFIED, never re-implemented)
    expect(d.runner.executed.filter((t) => t.id === 'exec-01-T01').length).toBe(execCountAfterFirst);
    // plan was not regenerated and no redundant spec task was dispatched
    expect(d.runner.executed.filter((t) => t.id === 'plan-01-r0').length).toBe(1);
    expect(d.runner.executed.some((t) => t.id.startsWith('spec-'))).toBe(false);
    // both tasks reached DONE through the full lifecycle
    const finalPlan = readPlan(planPath);
    expect(finalPlan.tasks.every((t) => t.status === 'DONE' && t.done)).toBe(true);
  });

  it('parallel tasks with disjoint write scopes run in one batch; overlapping are serialized', async () => {
    const d = deps(root, {
      planPayload: (phaseId) => ({
        phase: phaseId,
        tasks: [
          { id: 'T01', name: 'a', requirement_ids: phaseReqIds(root, phaseId), technical_justification: null, files: ['src/a.ts'], mapped_references: [{ path: 'src/a.ts', intent: 'new', parent_module: 'greenfield-root', placement_evidence: [{ path: '.', reason: 'fixture root' }] }], write_scope: ['src/a.ts'], depends_on: [], parallel: true, tdd: false, tests: ['echo ok'], evidence_expected: 'e', done: false },
          { id: 'T02', name: 'b', requirement_ids: [], technical_justification: 'x', files: ['src/b.ts'], mapped_references: [{ path: 'src/b.ts', intent: 'new', parent_module: 'greenfield-root', placement_evidence: [{ path: '.', reason: 'fixture root' }] }], write_scope: ['src/b.ts'], depends_on: [], parallel: true, tdd: false, tests: [], evidence_expected: 'e', done: false },
        ],
      }),
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok).toBe(true);
    // Both parallel workers and the dependent integration task were dispatched.
    const workers = d.runner.executed.filter((t) => t.id.startsWith('exec-01-'));
    expect(workers).toHaveLength(3);
  });

  it('scope violation by a worker is rejected and leaves no changes', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id === 'exec-01-T01',
      (t) => {
        // the worker REALLY writes outside its scope, inside its workspace,
        // and hides it from files_written (lying payload)
        const base = t.workspace!.root;
        fs.mkdirSync(path.join(base, 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'src', 'a.ts'), '// in scope\n');
        fs.writeFileSync(path.join(base, 'src', 'OUTSIDE.ts'), '// hidden out-of-scope\n');
        return ok(t, { files_written: ['src/a.ts'], payload: { done: true, notes: '' } });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/outside its individual write scope/);
    // NOTHING from the violating attempt reached the checkout — not even the
    // in-scope part (the workspace is discarded whole)
    expect(fs.existsSync(path.join(root, 'src', 'OUTSIDE.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'a.ts'))).toBe(false);
  });
});
