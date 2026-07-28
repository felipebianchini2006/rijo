import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { RijoPaths } from '../src/core/paths.js';
import { detectDrift, readManifest, touchManifest } from '../src/core/manifest.js';
import { readRequirements, readRoadmap } from '../src/core/roadmap.js';
import { readState } from '../src/core/state.js';
import { planContractHash, readPlan, writePlan } from '../src/core/plan.js';
import { sha256File } from '../src/core/fsx.js';
import { FakeShellRunner, type ShellRunner } from '../src/core/commands.js';
import { defaultConfig } from '../src/core/config.js';
import { createWorkflowEpoch } from '../src/core/workflow-epoch.js';
import { TaskStore } from '../src/supervisor/store.js';
import { reconcileSupervisedTasks } from '../src/supervisor/recover.js';
import { tmpProject, cleanup, writePlanFile, deps, ok, phaseReqIds, newMappedReference } from './helpers.js';

function milestoneDir(root: string): string {
  const paths = new RijoPaths(root);
  const manifest = readManifest(paths)!;
  const m = manifest.milestones.find((x) => x.id === manifest.active_milestone)!;
  return paths.milestoneDir(m.id, m.slug);
}

function toolingBindingPlan(root: string, phaseId: string) {
  const existingReference = (relativePath: string) => ({
    path: relativePath,
    intent: 'existing' as const,
    file_hash: sha256File(path.join(root, relativePath)),
  });
  return {
    phase: phaseId,
    tasks: [
      {
        id: 'T01',
        name: 'Update the project manifest',
        requirement_ids: phaseReqIds(root, phaseId),
        technical_justification: null,
        files: ['package.json', 'package-lock.json'],
        mapped_references: [
          existingReference('package.json'),
          existingReference('package-lock.json'),
        ],
        write_scope: ['package.json', 'package-lock.json'],
        depends_on: [],
        parallel: false,
        tdd: false,
        tests: ['npm run typecheck'],
        evidence_expected: 'The project manifest preserves its tooling binding.',
      },
      {
        id: 'T02',
        name: 'Add the source module',
        requirement_ids: [],
        technical_justification: 'The source module implements the bounded behavior.',
        files: ['src/a.ts'],
        mapped_references: [newMappedReference('src/a.ts')],
        write_scope: ['src/a.ts'],
        depends_on: ['T01'],
        parallel: false,
        tdd: false,
        tests: ['npm run typecheck'],
        evidence_expected: 'The source module passes the type check.',
      },
      {
        id: 'T03',
        name: 'Add the integration entry point',
        requirement_ids: [],
        technical_justification: 'The entry point connects the source module.',
        files: ['src/index.ts'],
        mapped_references: [newMappedReference('src/index.ts')],
        write_scope: ['src/index.ts'],
        depends_on: ['T02'],
        parallel: false,
        tdd: false,
        tests: ['npm run typecheck'],
        evidence_expected: 'The entry point passes the type check.',
      },
    ],
  };
}

function writeToolingBindingFixture(
  root: string,
  exactVersion: string,
  isolated = false,
): { manifest: string; lock: string } {
  const manifest = JSON.stringify({
    private: true,
    devDependencies: isolated ? {} : { rijo: exactVersion },
  }, null, 2) + '\n';
  const lock = JSON.stringify({
    lockfileVersion: 3,
    packages: isolated
      ? { '': {} }
      : {
          '': { devDependencies: { rijo: exactVersion } },
          'node_modules/rijo': { version: exactVersion },
        },
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(root, 'package.json'), manifest);
  fs.writeFileSync(path.join(root, 'package-lock.json'), lock);
  fs.writeFileSync(
    path.join(root, '.rijo', 'tooling-binding.json'),
    JSON.stringify({
      schema_version: 1,
      rijo_version: exactVersion,
      isolated,
      tooling_root: isolated ? '.rijo/tooling' : '.',
      manifest: isolated ? '.rijo/tooling/package.json' : 'package.json',
      lockfile: isolated ? '.rijo/tooling/package-lock.json' : 'package-lock.json',
      launcher: '.rijo/bin/rijo.cjs',
      managed_paths: [],
    }, null, 2) + '\n',
  );
  return { manifest, lock };
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
    expect(planner.objective).toContain(
      'If a task edits an existing npm package.json and package-lock.json exists',
    );
    expect(planner.return_format).toContain('executable command strings only');
    expect(planner.return_format).toContain('parent_module:"project-root"');
    expect(planner.return_format).toContain('package.json as the existing project-root bootstrap contract');
    const planReviewer = d.runner.executed.find((task) => task.id === 'plan-review-01-r0')!;
    expect(planReviewer.return_format).toContain('type MUST be exactly one of intent_gap|spec_gap');
    expect(planReviewer.canonical_files).toEqual(
      expect.arrayContaining([
        path.join(mdir, 'SCOPE.md'),
        path.join(mdir, 'REQUIREMENTS.md'),
        path.join(mdir, 'ROADMAP.md'),
      ]),
    );
    expect(planReviewer.objective).toContain(
      'REQUIREMENTS.md and ROADMAP.md are authoritative for phase allocation',
    );
    expect(planReviewer.objective).toContain(
      'Do not pull requirements assigned to a later phase into this plan',
    );
    expect(planReviewer.notes).toContain('Active phase: 01 — Catalog');
    expect(planReviewer.notes).toContain('Later phase allocations:');
    expect(planReviewer.notes).toMatch(/02 — Checkout: M001-REQ-\d+/);
    expect(planReviewer.notes).toContain(
      `Plan contract SHA-256: ${planContractHash(
        readPlan(path.join(phaseDir, 'PLAN.md')),
      )}`,
    );
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

  it.each([
    { failure: 'scope', expected: 'NPM_LOCK_SCOPE' },
    { failure: 'missing-reference', expected: 'NPM_LOCK_REFERENCE' },
    { failure: 'stale-reference', expected: 'NPM_LOCK_REFERENCE' },
  ])('rejects an npm manifest plan with invalid lockfile $failure', async ({
    failure,
    expected,
  }) => {
    const d = deps(root, {
      planPayload: (phaseId) => {
        const requirementIds = phaseReqIds(root, phaseId);
        const includesLockScope = failure !== 'scope';
        const lockReferences =
          failure === 'scope' || failure === 'missing-reference'
            ? []
            : [
                {
                  path: 'package-lock.json',
                  intent: 'existing' as const,
                  file_hash: '0'.repeat(64),
                },
              ];
        return {
          phase: phaseId,
          tasks: [
            {
              id: 'T01',
              name: 'Update the project manifest',
              requirement_ids: requirementIds,
              technical_justification: null,
              files: includesLockScope
                ? ['package.json', 'package-lock.json']
                : ['package.json'],
              mapped_references: [
                {
                  path: 'package.json',
                  intent: 'existing' as const,
                  file_hash: sha256File(path.join(root, 'package.json')),
                },
                ...lockReferences,
              ],
              write_scope: includesLockScope
                ? ['package.json', 'package-lock.json']
                : ['package.json'],
              depends_on: [],
              parallel: false,
              tdd: false,
              tests: ['npm run typecheck'],
              evidence_expected: 'The project manifest defines the build.',
            },
            {
              id: 'T02',
              name: 'Add the source module',
              requirement_ids: [],
              technical_justification: 'The source module implements the bounded behavior.',
              files: ['src/a.ts'],
              mapped_references: [newMappedReference('src/a.ts')],
              write_scope: ['src/a.ts'],
              depends_on: ['T01'],
              parallel: false,
              tdd: false,
              tests: ['npm run typecheck'],
              evidence_expected: 'The source module passes the type check.',
            },
            {
              id: 'T03',
              name: 'Add the integration entry point',
              requirement_ids: [],
              technical_justification: 'The entry point connects the source module.',
              files: ['src/index.ts'],
              mapped_references: [newMappedReference('src/index.ts')],
              write_scope: ['src/index.ts'],
              depends_on: ['T02'],
              parallel: false,
              tdd: false,
              tests: ['npm run typecheck'],
              evidence_expected: 'The entry point passes the type check.',
            },
          ],
        };
      },
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"":{"private":true}}}\n',
    );

    const outcome = await runWorkflow(root, {}, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.details?.join('\n')).toContain(expected);
    const planner = d.runner.executed.find((task) => task.id === 'plan-01-r0')!;
    expect(planner.canonical_files).toEqual(
      expect.arrayContaining([
        path.join(root, 'package.json'),
        path.join(root, 'package-lock.json'),
      ]),
    );
  });

  it.each([
    {
      caseName: 'manifest requirement',
      target: 'package.json',
      content: '{"private":true,"devDependencies":{"typescript":"^5.9.0"}}\n',
      expected: 'package.json must preserve',
    },
    {
      caseName: 'root lock requirement',
      target: 'package-lock.json',
      content:
        '{"lockfileVersion":3,"packages":{"":{},"node_modules/rijo":{"version":"0.2.0-rc.1"}}}\n',
      expected: 'root RIJO devDependency',
    },
    {
      caseName: 'installed lock package',
      target: 'package-lock.json',
      content:
        '{"lockfileVersion":3,"packages":{"":{"devDependencies":{"rijo":"0.2.0-rc.1"}},"node_modules/rijo":{"version":"0.1.0"}}}\n',
      expected: 'installed RIJO package',
    },
    {
      caseName: 'malformed manifest',
      target: 'package.json',
      content: '{\n',
      expected: 'package.json must contain valid JSON',
    },
    {
      caseName: 'malformed lockfile',
      target: 'package-lock.json',
      content: '{\n',
      expected: 'package-lock.json must contain valid JSON',
    },
  ])(
    'rejects a worker that corrupts the project-local RIJO $caseName',
    async ({ target, content, expected }) => {
    const exactVersion = '0.2.0-rc.1';
    const d = deps(root, {
      planPayload: (phaseId) => toolingBindingPlan(root, phaseId),
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const { manifest: originalManifest, lock: originalLock } =
      writeToolingBindingFixture(root, exactVersion);
    d.runner.on(
      (task) => task.id === 'exec-01-T01',
      (task) => {
        fs.writeFileSync(
          path.join(task.workspace!.root, target),
          content,
        );
        return ok(task, {
          files_written: [target],
          payload: { done: true, notes: 'Updated project tooling.' },
        });
      },
    );

    const outcome = await runWorkflow(root, {}, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('changed the project-local RIJO tooling binding');
    expect(outcome.details?.join('\n')).toContain(expected);
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(
      originalManifest,
    );
    expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).toBe(
      originalLock,
    );
  });

  it('does not enforce the application manifest for an isolated tooling binding', async () => {
    const exactVersion = '0.2.0-rc.1';
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    writeToolingBindingFixture(root, exactVersion, true);

    const outcome = await runWorkflow(root, {}, d);

    expect(outcome.ok, outcome.message).toBe(true);
  });

  it('rejects a repair worker that changes the project-local RIJO lock binding', async () => {
    const exactVersion = '0.2.0-rc.1';
    const d = deps(root, {
      planPayload: (phaseId) => toolingBindingPlan(root, phaseId),
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const { lock: originalLock } = writeToolingBindingFixture(root, exactVersion);
    d.runner.on(
      (task) => task.id === 'exec-01-T01',
      (task) => {
        fs.writeFileSync(
          path.join(task.workspace!.root, 'package.json'),
          JSON.stringify({
            private: true,
            scripts: { typecheck: 'node --test' },
            devDependencies: { rijo: exactVersion },
          }, null, 2) + '\n',
        );
        return ok(task, {
          files_written: ['package.json'],
          payload: { done: true, notes: 'Added the project script.' },
        });
      },
    );
    d.runner.on(
      (task) => task.id.startsWith('code-review-01-'),
      (task) =>
        ok(task, {
          payload: {
            approved: true,
            findings: [
              {
                type: 'implementation_bug',
                severity: 'high',
                description: 'Repair the package integration.',
                file: 'package-lock.json',
              },
            ],
          },
        }),
    );
    d.runner.on(
      (task) => task.id.startsWith('review-fix-01-'),
      (task) => {
        fs.writeFileSync(
          path.join(task.workspace!.root, 'package-lock.json'),
          '{"lockfileVersion":3,"packages":{"":{}}}\n',
        );
        return ok(task, {
          files_written: ['package-lock.json'],
          payload: { done: true, notes: 'Changed the lockfile.' },
        });
      },
    );

    const outcome = await runWorkflow(root, {}, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain(
      'repair worker changed the project-local RIJO tooling binding',
    );
    expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).toBe(
      originalLock,
    );
    const repair = d.runner.executed.find((task) =>
      task.id.startsWith('review-fix-01-'),
    )!;
    expect(repair.objective).toContain(
      'Preserve the exact project-local RIJO dependency',
    );
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
    const revisedPlan = d.runner.executed.find((t) => t.id === 'plan-01-r1')!;
    expect(revisedPlan.canonical_files).toEqual(
      expect.arrayContaining([
        path.join(milestoneDir(root), 'REQUIREMENTS.md'),
        path.join(milestoneDir(root), 'ROADMAP.md'),
      ]),
    );
    expect(revisedPlan.notes).toContain(
      'Previous review issues to address within the active phase boundary:',
    );
    expect(revisedPlan.notes).toContain(
      'A reviewer finding does not expand the phase.',
    );
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
    d.runner.on(
      (task) => task.id.startsWith('review-fix-'),
      (task) => {
        const target = path.join(task.workspace!.root, 'src', 'a.ts');
        fs.appendFileSync(target, 'export const reviewedRepair = true;\n');
        return ok(task, {
          files_written: ['src/a.ts'],
          payload: { done: true, notes: 'Applied the review repair.' },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(d.runner.executed.some((t) => t.id.startsWith('review-fix-01-'))).toBe(true);
    expect(reviews).toBe(2);
  });

  it('applies a pending native review repair before it exports the next review', async () => {
    const d = deps(root);
    const workflowEpoch = createWorkflowEpoch();
    let reviews = 0;
    let repairs = 0;
    d.runner.on(
      (task) => task.id.startsWith('code-review-'),
      (task) => {
        reviews++;
        if (reviews === 1) {
          return ok(task, {
            payload: {
              approved: false,
              findings: [
                {
                  type: 'implementation_bug',
                  severity: 'high',
                  description: 'Add the durable repair marker.',
                  file: 'src/a.ts',
                },
              ],
            },
          });
        }
        if (reviews === 2) {
          return ok(task, {
            ok: false,
            summary:
              'The native result bundle has no result for task code-review-01-l1 because no exact native identity matched.',
          });
        }
        return ok(task, { payload: { approved: true, findings: [] } });
      },
    );
    d.runner.on(
      (task) => task.id.startsWith('review-fix-'),
      (task) => {
        repairs++;
        if (repairs === 1) {
          return ok(task, {
            ok: false,
            summary:
              'The native result bundle has no result for task review-fix-01-l1 because no exact native identity matched.',
          });
        }
        const target = path.join(task.workspace!.root, 'src', 'a.ts');
        fs.appendFileSync(target, 'export const repairedAfterNativePause = true;\n');
        return ok(task, {
          files_written: ['src/a.ts'],
          payload: { done: true, notes: 'Applied the repair.' },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const runtime = { ...d, workflowEpoch };

    await expect(runWorkflow(root, {}, runtime)).rejects.toThrow(
      'NATIVE_RESULT_REQUIRED: The native result bundle has no result for task review-fix-01-l1',
    );
    const legacyReceiptPath = path.join(
      milestoneDir(root),
      'phases',
      '01-catalog',
      'REPAIR.json',
    );
    fs.rmSync(legacyReceiptPath);
    touchManifest(new RijoPaths(root), () => {}, () => new Date('2026-07-23T12:00:00.000Z'));
    const repairStore = new TaskStore(new RijoPaths(root));
    const pendingRepair = repairStore.read('review-fix-01-l1')!;
    const restartingRepair = repairStore.transition(
      pendingRepair,
      'STARTING',
      {},
      { reason: 'Simulated replacement start before a process crash.' },
    );
    repairStore.transition(
      restartingRepair,
      'RUNNING',
      {},
      { reason: 'Simulated process crash during the replacement attempt.' },
    );
    await reconcileSupervisedTasks(new RijoPaths(root), {
      maxReplacements: 2,
      unknownTimeoutMs: 1,
    });
    expect(repairStore.read('review-fix-01-l1')).toMatchObject({
      state: 'REPLACING',
      workspace_id: null,
      revoked_leases: [pendingRepair.lease_id],
    });
    await expect(runWorkflow(root, {}, runtime)).rejects.toThrow(
      'NATIVE_RESULT_REQUIRED: The native result bundle has no result for task code-review-01-l1',
    );

    const repairedSource = fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');
    expect(repairedSource).toContain(
      'repairedAfterNativePause',
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(milestoneDir(root), 'phases', '01-catalog', 'REPAIR.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      kind: 'review',
      loop: 1,
      status: 'APPLIED',
      task: { id: 'review-fix-01-l1' },
    });
    expect(new TaskStore(new RijoPaths(root)).read('review-fix-01-l1')?.state).toBe(
      'SUCCEEDED',
    );

    const sourcePath = path.join(root, 'src', 'a.ts');
    const baselinePath = path.join(
      root,
      '.rijo',
      'runtime',
      'phase-baselines',
      'M001-01.json',
    );
    const withoutRepair = repairedSource.replace(
      'export const repairedAfterNativePause = true;\n',
      '',
    );
    fs.writeFileSync(sourcePath, withoutRepair);
    const rewriteControlledHash = () => {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
        controlled_snapshot: Array<[string, string]>;
      };
      baseline.controlled_snapshot = baseline.controlled_snapshot.map(([file, hash]) =>
        file === 'src/a.ts' ? [file, sha256File(sourcePath)] : [file, hash],
      );
      fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    };
    rewriteControlledHash();
    const missingPatch = await runWorkflow(root, {}, runtime);
    expect(missingPatch.status).toBe('blocked');
    expect(missingPatch.message).toContain(
      'applied repair receipt does not match the controlled checkout',
    );

    fs.writeFileSync(sourcePath, repairedSource);
    rewriteControlledHash();
    const outcome = await runWorkflow(root, {}, runtime);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(repairs).toBe(2);
    expect(reviews).toBe(3);
  });

  it('recovers a committed review repair after a crash before its receipt advances', async () => {
    const d = deps(root);
    let reviews = 0;
    let repairs = 0;
    d.runner.on(
      (task) => task.id.startsWith('code-review-'),
      (task) => {
        reviews++;
        return ok(task, {
          payload:
            reviews === 1
              ? {
                  approved: false,
                  findings: [
                    {
                      type: 'implementation_bug',
                      severity: 'high',
                      description: 'Add the crash-safe repair marker.',
                      file: 'src/a.ts',
                    },
                  ],
                }
              : { approved: true, findings: [] },
        });
      },
    );
    d.runner.on(
      (task) => task.id.startsWith('review-fix-'),
      (task) => {
        repairs++;
        const target = path.join(task.workspace!.root, 'src', 'a.ts');
        fs.appendFileSync(target, 'export const recoveredRepair = true;\n');
        return ok(task, {
          files_written: ['src/a.ts'],
          payload: { done: true, notes: 'Applied the repair.' },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    let injected = false;

    await expect(
      runWorkflow(root, {}, {
        ...d,
        taskPatchHooks: {
          afterApplied: (_transactionId, taskId) => {
            if (injected || !taskId.startsWith('review-fix-')) return;
            injected = true;
            throw new Error('INJECTED-CRASH after review repair apply');
          },
        },
      }),
    ).rejects.toThrow('INJECTED-CRASH after review repair apply');

    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain(
      'recoveredRepair',
    );
    const repairPath = path.join(
      milestoneDir(root),
      'phases',
      '01-catalog',
      'REPAIR.json',
    );
    expect(JSON.parse(fs.readFileSync(repairPath, 'utf8'))).toMatchObject({
      status: 'PENDING',
      task: { id: 'review-fix-01-l1' },
    });

    const resumed = await runWorkflow(root, {}, d);

    expect(resumed.ok, resumed.message).toBe(true);
    expect(JSON.parse(fs.readFileSync(repairPath, 'utf8'))).toMatchObject({
      status: 'APPLIED',
      task: { id: 'review-fix-01-l1' },
    });
    expect(repairs).toBe(1);
    expect(reviews).toBe(2);
    expect(
      fs.readdirSync(path.join(root, '.rijo', 'runtime', 'transactions')),
    ).toEqual([]);
    fs.appendFileSync(repairPath, ' ');
    expect(detectDrift(new RijoPaths(root)).drifted).toContain(
      path.relative(path.join(root, '.rijo'), repairPath).split(path.sep).join('/'),
    );
  });

  it('resumes a pending native verification repair before it verifies again', async () => {
    const d = deps(root);
    const sourcePath = path.join(root, 'src', 'a.ts');
    const shell: ShellRunner = {
      run(command, options) {
        if (
          command === 'echo test-a' &&
          (!fs.existsSync(sourcePath) ||
            !fs.readFileSync(sourcePath, 'utf8').includes('verificationRepair'))
        ) {
          return {
            command,
            exit_code: 1,
            summary: 'The verification repair is not present.',
            duration_ms: 1,
            blocked: false,
            category: 'test',
            sandbox: 'test-double',
            trust: 'repository-script',
            network: 'none',
          };
        }
        return d.shell.run(command, options);
      },
    };
    let repairs = 0;
    d.runner.on(
      (task) => task.id.startsWith('verify-fix-'),
      (task) => {
        repairs++;
        if (repairs === 1) {
          return ok(task, {
            ok: false,
            summary:
              'The native result bundle has no result for task verify-fix-01-l1 because no exact native identity matched.',
          });
        }
        const target = path.join(task.workspace!.root, 'src', 'a.ts');
        fs.appendFileSync(target, 'export const verificationRepair = true;\n');
        return ok(task, {
          files_written: ['src/a.ts'],
          payload: { done: true, notes: 'Applied the verification repair.' },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, { ...d, shell });
    const runtime = { ...d, shell, workflowEpoch: createWorkflowEpoch() };

    await expect(runWorkflow(root, {}, runtime)).rejects.toThrow(
      'NATIVE_RESULT_REQUIRED: The native result bundle has no result for task verify-fix-01-l1',
    );
    const resumed = await runWorkflow(root, {}, runtime);

    expect(resumed.ok, resumed.message).toBe(true);
    expect(fs.readFileSync(sourcePath, 'utf8')).toContain('verificationRepair');
    expect(repairs).toBe(2);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(milestoneDir(root), 'phases', '01-catalog', 'REPAIR.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      kind: 'verification',
      loop: 1,
      status: 'APPLIED',
      task: { id: 'verify-fix-01-l1' },
    });
  });

  it('rejects an applied repair receipt when its safe symlink disappears', async () => {
    const d = deps(root);
    let reviews = 0;
    let repairs = 0;
    d.runner.on(
      (task) => task.id.startsWith('code-review-'),
      (task) => {
        reviews++;
        if (reviews === 1) {
          return ok(task, {
            payload: {
              approved: false,
              findings: [
                {
                  type: 'implementation_bug',
                  severity: 'high',
                  description: 'Replace the module with the approved internal link.',
                  file: 'src/a.ts',
                },
              ],
            },
          });
        }
        if (reviews === 2) {
          return ok(task, {
            payload: {
              approved: false,
              findings: [
                {
                  type: 'implementation_bug',
                  severity: 'high',
                  description: 'Add the second bounded repair.',
                  file: 'src/b.ts',
                },
              ],
            },
          });
        }
        return ok(task, {
          ok: false,
          summary:
            'The native result bundle has no result for task code-review-01-l2 because no exact native identity matched.',
        });
      },
    );
    d.runner.on(
      (task) => task.id.startsWith('review-fix-'),
      (task) => {
        repairs++;
        const relative = repairs === 1 ? 'src/a.ts' : 'src/b.ts';
        const target = path.join(task.workspace!.root, relative);
        if (repairs === 1) {
          fs.rmSync(target);
          fs.symlinkSync('b.ts', target);
        } else {
          fs.appendFileSync(target, 'export const secondRepair = true;\n');
        }
        return ok(task, {
          files_written: [relative],
          payload: { done: true, notes: 'Applied the bounded repair.' },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const runtime = { ...d, workflowEpoch: createWorkflowEpoch() };

    await expect(runWorkflow(root, {}, runtime)).rejects.toThrow(
      'NATIVE_RESULT_REQUIRED: The native result bundle has no result for task code-review-01-l2',
    );

    const linkedPath = path.join(root, 'src', 'a.ts');
    expect(fs.lstatSync(linkedPath).isSymbolicLink()).toBe(true);
    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(milestoneDir(root), 'phases', '01-catalog', 'REPAIR.json'),
        'utf8',
      ),
    ) as {
      controlled_updates: Array<{
        path: string;
        state: { kind: string; target?: string };
      }>;
    };
    expect(receipt.controlled_updates).toEqual(
      expect.arrayContaining([
        { path: 'src/a.ts', state: { kind: 'symlink', target: 'b.ts' } },
        expect.objectContaining({
          path: 'src/b.ts',
          state: expect.objectContaining({ kind: 'file' }),
        }),
      ]),
    );
    fs.rmSync(linkedPath);
    const resumed = await runWorkflow(root, {}, runtime);

    expect(resumed.status).toBe('blocked');
    expect(resumed.details?.join('\n')).toContain(
      'Current symlink does not match the repair receipt: src/a.ts.',
    );
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
    const planPath = path.join(milestoneDir(root), 'phases', '01-catalog', 'PLAN.md');
    const approved = readPlan(planPath);
    expect(approved.approved_plan?.plan_contract_hash).toBe(planContractHash(approved));
    const planReviewCount = d.runner.executed.filter((task) =>
      task.id.startsWith('plan-review-01-'),
    ).length;
    fs.rmSync(path.join(root, '.rijo', 'runtime', 'plan-approvals'), {
      recursive: true,
      force: true,
    });

    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) => ok(t, { payload: { approved: true, findings: [] } }),
    );
    const resumed = await runWorkflow(root, {}, d);
    expect(resumed.ok, resumed.message).toBe(true);
    expect(
      d.runner.executed.filter((task) => task.id.startsWith('plan-review-01-')).length,
    ).toBe(planReviewCount);
    const implementation = d.git.commits.find((commit) => commit.message.includes('verified'))!;
    expect(implementation.paths).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
  });

  it('blocks an edited in-progress plan when portable approval no longer matches', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id.startsWith('code-review-'),
      (task) =>
        ok(task, {
          payload: {
            approved: false,
            findings: [
              {
                type: 'spec_gap',
                severity: 'high',
                description: 'pause after implementation',
                file: null,
              },
            ],
          },
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    expect((await runWorkflow(root, {}, d)).status).toBe('blocked');

    const planPath = path.join(milestoneDir(root), 'phases', '01-catalog', 'PLAN.md');
    const edited = readPlan(planPath);
    edited.tasks[0]!.name = 'silently edited task contract';
    writePlan(planPath, edited, 'edited after approval');
    touchManifest(new RijoPaths(root), () => {}, () => new Date());
    fs.rmSync(path.join(root, '.rijo', 'runtime', 'plan-approvals'), {
      recursive: true,
      force: true,
    });

    const resumed = await runWorkflow(root, {}, d);
    expect(resumed.status).toBe('blocked');
    expect(resumed.message).toContain('approved plan contract changed without invalidation');
    expect(readPlan(planPath).tasks[0]!.name).toBe('silently edited task contract');
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

  it('recovers a committed worker patch after a crash before the task projection', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    let injected = false;

    await expect(
      runWorkflow(root, {}, {
        ...d,
        taskPatchHooks: {
          afterApplied: () => {
            if (injected) return;
            injected = true;
            throw new Error('INJECTED-CRASH after task patch apply');
          },
        },
      }),
    ).rejects.toThrow('INJECTED-CRASH after task patch apply');

    const planPath = path.join(milestoneDir(root), 'phases', '01-catalog', 'PLAN.md');
    expect(readPlan(planPath).tasks[0]!.status).toBe('RUNNING');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('exec-01-T01');
    const transactionRoot = path.join(root, '.rijo', 'runtime', 'transactions');
    expect(fs.readdirSync(transactionRoot)).toHaveLength(1);
    const firstTaskRuns = d.runner.executed.filter((task) => task.id === 'exec-01-T01').length;

    fs.writeFileSync(path.join(root, 'external-note.txt'), 'external and unrelated\n');
    const resumed = await runWorkflow(root, {}, d);

    expect(resumed.ok, resumed.message).toBe(true);
    expect(d.runner.executed.filter((task) => task.id === 'exec-01-T01')).toHaveLength(
      firstTaskRuns,
    );
    expect(fs.readFileSync(path.join(root, 'external-note.txt'), 'utf8')).toBe(
      'external and unrelated\n',
    );
    expect(d.git.commits.flatMap((commit) => commit.paths)).not.toContain(
      'external-note.txt',
    );
    expect(fs.readdirSync(transactionRoot)).toEqual([]);
  });

  it('keeps a task running when external bytes conflict with its retained patch', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    let injected = false;
    const crashDeps = {
      ...d,
      taskPatchHooks: {
        afterApplied: () => {
          if (injected) return;
          injected = true;
          throw new Error('INJECTED-CRASH after task patch apply');
        },
      },
    };
    await expect(runWorkflow(root, {}, crashDeps)).rejects.toThrow(
      'INJECTED-CRASH after task patch apply',
    );
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'external conflicting bytes\n');

    await expect(runWorkflow(root, {}, d)).rejects.toThrow(
      /did not overwrite these paths/,
    );

    const planPath = path.join(milestoneDir(root), 'phases', '01-catalog', 'PLAN.md');
    expect(readPlan(planPath).tasks[0]!.status).toBe('RUNNING');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe(
      'external conflicting bytes\n',
    );
    expect(
      fs.readdirSync(path.join(root, '.rijo', 'runtime', 'transactions')),
    ).toHaveLength(1);
  });

  it('verification failure does not advance state (atomicity) and bounded repair applies', async () => {
    const d = deps(root);
    // shell always fails for the plan's test command
    const failingShell = new FakeShellRunner([{ match: /echo test-a/, exitCode: 1, output: 'FAIL' }]);
    const d2 = { ...d, shell: failingShell };
    let repairWrites = 0;
    d.runner.on(
      (task) => task.id.startsWith('verify-fix-'),
      (task) => {
        repairWrites++;
        const target = path.join(task.workspace!.root, 'src', 'a.ts');
        fs.appendFileSync(
          target,
          `export const verificationRepair${repairWrites} = true;\n`,
        );
        return ok(task, {
          files_written: ['src/a.ts'],
          payload: { done: true, notes: 'Applied a bounded verification repair.' },
        });
      },
    );
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

  it.each([
    ['a missing declared test file', 'missing-test'],
    ['an incomplete RED test environment', 'incomplete-environment'],
  ])(
    'replaces a writer generation after %s and preserves earlier task work',
    async (_caseName, failureMode) => {
      const redAwareShell = {
        run(command: string, options: { cwd?: string } = {}) {
          const cwd = options.cwd ?? root;
          if (command.includes('feature.test.mjs')) {
            const testFile = path.join(cwd, 'test', 'feature.test.mjs');
            const testText = fs.existsSync(testFile)
              ? fs.readFileSync(testFile, 'utf8')
              : '';
            if (testText.includes('missing-module')) {
              return {
                command,
                exit_code: 1,
                summary: 'ENOENT: missing-module could not be loaded.',
                duration_ms: 1,
                blocked: false,
                category: 'test' as const,
                sandbox: 'test-double',
                trust: 'repository-script',
                network: 'none',
              };
            }
            const implemented = fs.existsSync(path.join(cwd, 'src', 'feature.mjs'));
            return {
              command,
              exit_code: implemented ? 0 : 1,
              summary: implemented
                ? 'pass'
                : 'AssertionError: expected the feature behavior.',
              duration_ms: 1,
              blocked: false,
              category: 'test' as const,
              sandbox: 'test-double',
              trust: 'repository-script',
              network: 'none',
            };
          }
          return {
            command,
            exit_code: 0,
            summary: 'pass',
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
              name: 'Create the phase foundation',
              requirement_ids: [],
              technical_justification: 'The foundation is required by the tested behavior.',
              files: ['src/foundation.mjs'],
              mapped_references: [newMappedReference('src/foundation.mjs')],
              write_scope: ['src/foundation.mjs'],
              depends_on: [],
              parallel: false,
              tdd: false,
              tests: ['node --check src/foundation.mjs'],
              evidence_expected: 'The foundation syntax is valid.',
              done: false,
            },
            {
              id: 'T02',
              name: 'Add the tested behavior',
              requirement_ids: phaseReqIds(root, phaseId),
              technical_justification: null,
              files: ['src/feature.mjs', 'test/feature.test.mjs'],
              mapped_references: [
                newMappedReference('src/feature.mjs'),
                newMappedReference('test/feature.test.mjs'),
              ],
              write_scope: ['src/feature.mjs', 'test/feature.test.mjs'],
              depends_on: ['T01'],
              parallel: false,
              tdd: true,
              tests: ['node --test test/feature.test.mjs'],
              evidence_expected: 'The behavior test passes.',
              done: false,
            },
            {
              id: 'T03',
              name: 'Record the bounded integration',
              requirement_ids: [],
              technical_justification: 'The marker records the phase integration.',
              files: ['src/integration.mjs'],
              mapped_references: [newMappedReference('src/integration.mjs')],
              write_scope: ['src/integration.mjs'],
              depends_on: ['T02'],
              parallel: false,
              tdd: false,
              tests: [],
              evidence_expected: 'The integration marker exists.',
              done: false,
            },
          ],
        }),
      });
      d.runner.on(
        (task) => task.id === 'exec-01-T02',
        (task) => {
          const workspace = task.workspace!.root;
          fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
          fs.writeFileSync(
            path.join(workspace, 'src', 'feature.mjs'),
            'export const feature = true;\n',
          );
          const correction = task.notes.includes(
            'The prior result failed deterministic TDD RED validation.',
          );
          const written = ['src/feature.mjs'];
          if (correction || failureMode === 'incomplete-environment') {
            fs.mkdirSync(path.join(workspace, 'test'), { recursive: true });
            fs.writeFileSync(
              path.join(workspace, 'test', 'feature.test.mjs'),
              correction
                ? "throw new Error('expected the feature behavior');\n"
                : "import './missing-module.mjs';\n",
            );
            written.push('test/feature.test.mjs');
          }
          return ok(task, {
            files_written: written,
            payload: { done: true, notes: correction ? 'corrected' : 'first result' },
          });
        },
      );
      const wired = {
        ...d,
        shell: redAwareShell,
        supervisorConfig: {
          ...defaultConfig().supervisor,
          max_replacements_per_task: 2,
          replacement_backoff_ms: [],
        },
      };

      await newWorkflow(root, { planFile: '@PLAN.md' }, wired);
      const outcome = await runWorkflow(root, { target: '01' }, wired);

      expect(outcome.ok, outcome.message).toBe(true);
      const foundationRuns = d.runner.executed.filter(
        (task) => task.id === 'exec-01-T01',
      );
      const featureRuns = d.runner.executed.filter(
        (task) => task.id === 'exec-01-T02',
      );
      expect(foundationRuns).toHaveLength(1);
      expect(featureRuns).toHaveLength(2);
      expect(featureRuns.map((task) => task.attempt?.generation)).toEqual([1, 2]);
      expect(featureRuns[0]!.workspace?.id).not.toBe(featureRuns[1]!.workspace?.id);
      expect(fs.existsSync(path.join(root, 'src', 'foundation.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'src', 'feature.mjs'))).toBe(true);
      expect(
        fs.existsSync(
          path.join(root, '.rijo', 'runtime', 'tdd-red-retries', 'M001-01-T02.json'),
        ),
      ).toBe(false);
      const record = new TaskStore(new RijoPaths(root)).read('exec-01-T02');
      expect(record?.state).toBe('SUCCEEDED');
      expect(record?.generation).toBe(2);
      expect(record?.replacement_count).toBe(1);
      expect(record?.revoked_leases).toHaveLength(1);
    },
  );

  it('keeps an exhausted task fenced in one epoch and retries it in a new explicit operation', async () => {
    const d = deps(root);
    const firstEpoch = createWorkflowEpoch();
    const firstOperation = { ...d, workflowEpoch: firstEpoch };
    // T02 worker fails on the first run
    let failT02 = true;
    d.runner.on(
      (t) => t.id === 'exec-01-T02' && failT02,
      (t) => ({ task_id: t.id, ok: false, summary: 'interrupted', files_written: [], payload: null, scope_requests: [] }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, firstOperation);
    const first = await runWorkflow(root, {}, firstOperation);
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
    const reviewCountAfterFirst = d.runner.executed.filter((t) => t.id.startsWith('plan-review-01-')).length;
    const approvedContract = planContractHash(readPlan(planPath));
    const exhaustedBefore = new TaskStore(new RijoPaths(root)).read('exec-01-T02')!;
    expect(exhaustedBefore.state).toBe('EXHAUSTED');
    expect(exhaustedBefore.workflow_epoch).toBe(firstEpoch);
    failT02 = false;
    const sameOperation = await runWorkflow(root, {}, firstOperation);
    expect(sameOperation.status).toBe('blocked');
    // T01 was not re-executed while the exhausted T02 remained fenced.
    expect(d.runner.executed.filter((t) => t.id === 'exec-01-T01').length).toBe(execCountAfterFirst);
    // plan was not regenerated and no redundant spec task was dispatched
    expect(d.runner.executed.filter((t) => t.id === 'plan-01-r0').length).toBe(1);
    expect(d.runner.executed.filter((t) => t.id.startsWith('plan-review-01-')).length)
      .toBe(reviewCountAfterFirst);
    expect(planContractHash(readPlan(planPath))).toBe(approvedContract);
    expect(d.runner.executed.some((t) => t.id.startsWith('spec-'))).toBe(false);
    const exhaustedInSameEpoch = new TaskStore(new RijoPaths(root)).read('exec-01-T02')!;
    expect(exhaustedInSameEpoch).toEqual(exhaustedBefore);
    expect(
      new TaskStore(new RijoPaths(root))
        .readEvents('exec-01-T02')
        .filter((event) => event.type === 'task_created'),
    ).toHaveLength(1);

    // A new public operation has a new epoch and may retry the unfinished task
    // from generation one without replaying already implemented T01.
    const secondEpoch = createWorkflowEpoch();
    const newOperation = await runWorkflow(
      root,
      {},
      { ...d, workflowEpoch: secondEpoch },
    );
    expect(newOperation.ok, newOperation.message).toBe(true);
    expect(secondEpoch).not.toBe(firstEpoch);
    expect(d.runner.executed.filter((t) => t.id === 'exec-01-T01').length).toBe(execCountAfterFirst);
    expect(d.runner.executed.filter((t) => t.id === 'exec-01-T02')).toHaveLength(2);

    const store = new TaskStore(new RijoPaths(root));
    expect(store.readArchived('exec-01-T02', firstEpoch)).toEqual(exhaustedBefore);
    expect(store.read('exec-01-T02')).toMatchObject({
      workflow_epoch: secondEpoch,
      state: 'SUCCEEDED',
      generation: 1,
      replacement_count: 0,
    });
    expect(
      store
        .readEvents('exec-01-T02')
        .filter((event) => event.type === 'task_created'),
    ).toHaveLength(1);
    expect(
      store
        .readEvents('exec-01-T02')
        .filter((event) => event.type === 'workflow_epoch_rolled_over'),
    ).toEqual([
      expect.objectContaining({
        workflow_epoch: secondEpoch,
        data: expect.objectContaining({
          prior_workflow_epoch: firstEpoch,
          prior_state: 'EXHAUSTED',
        }),
      }),
    ]);
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
