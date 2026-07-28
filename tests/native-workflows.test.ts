import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeFrontmatter } from '../src/core/frontmatter.js';
import { readManifest } from '../src/core/manifest.js';
import { RijoPaths } from '../src/core/paths.js';
import { readRequirements, writeRequirements } from '../src/core/roadmap.js';
import { finishWorkflow } from '../src/workflows/finish.js';
import { newWorkflow } from '../src/workflows/new.js';
import { selectResumeRoute } from '../src/workflows/resume.js';
import { startWorkflow } from '../src/workflows/run.js';
import { cleanup, deps, tmpProject, writePlanFile } from './helpers.js';

describe('native workflow lifecycle', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject('rijo-native-workflow-');
    writePlanFile(root, 'PLAN.md');
  });

  afterEach(() => cleanup(root));

  it('selects implementation and then full QA from deterministic state', async () => {
    const runtime = deps(root);
    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, runtime)).ok).toBe(true);
    expect(selectResumeRoute(root)).toEqual({ route: 'start' });

    const implementation = await startWorkflow(root, runtime);
    expect(implementation.ok, implementation.message).toBe(true);
    const phaseResearch = runtime.runner.executed.find(
      (task) => task.id === 'new-research-phase-01-r0',
    );
    expect(phaseResearch?.role).toBe('researcher');
    expect(phaseResearch?.return_format).toContain('tier:"official"');
    const pathsAfterStart = new RijoPaths(root);
    const manifestAfterStart = readManifest(pathsAfterStart)!;
    const activeAfterStart = manifestAfterStart.milestones.find(
      (candidate) => candidate.id === manifestAfterStart.active_milestone,
    )!;
    expect(
      fs.existsSync(
        path.join(
          pathsAfterStart.milestoneDir(activeAfterStart.id, activeAfterStart.slug),
          'phases',
          '01-catalog',
          'RESEARCH.md',
        ),
      ),
    ).toBe(true);
    expect(selectResumeRoute(root)).toEqual({ route: 'test' });

    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === manifest.active_milestone,
    )!;
    const readiness = path.join(
      paths.milestoneDir(milestone.id, milestone.slug),
      'qa',
      'production-readiness.md',
    );
    fs.writeFileSync(
      readiness,
      serializeFrontmatter(
        { status: 'READY', tested_commit: runtime.git.headCommit(root) },
        '# Product QA\n\nStatus: READY\n',
      ),
    );
    expect(selectResumeRoute(root)).toEqual({ route: 'finish' });
  });

  it('finish refuses incomplete work and seals a tested complete milestone', async () => {
    const runtime = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, runtime);
    expect((await finishWorkflow(root, runtime)).status).toBe('blocked');

    await startWorkflow(root, runtime);
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === manifest.active_milestone,
    )!;
    const milestoneDir = paths.milestoneDir(milestone.id, milestone.slug);
    fs.writeFileSync(
      path.join(milestoneDir, 'qa', 'production-readiness.md'),
      serializeFrontmatter(
        { status: 'READY', tested_commit: runtime.git.headCommit(root) },
        '# Product QA\n\nStatus: READY\n',
      ),
    );

    const result = await finishWorkflow(root, runtime);
    expect(result.ok, result.message).toBe(true);
    expect(fs.existsSync(path.join(milestoneDir, 'CLOSEOUT.md'))).toBe(true);
    expect(readManifest(paths)!.milestones[0]!.status).toBe('COMPLETE');
  });

  it('finish accepts portable RIJO evidence commits after the tested product commit', async () => {
    const runtime = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, runtime);
    await startWorkflow(root, runtime);
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === manifest.active_milestone,
    )!;
    const milestoneDir = paths.milestoneDir(milestone.id, milestone.slug);
    const testedCommit = runtime.git.headCommit(root)!;
    runtime.git.commitPaths(root, 'rijo(state): record QA evidence', [
      '.rijo/events.jsonl',
      '.rijo/manifest.json',
      `.rijo/milestones/${milestone.id}-${milestone.slug}/qa/production-readiness.md`,
    ]);
    fs.writeFileSync(
      path.join(milestoneDir, 'qa', 'production-readiness.md'),
      serializeFrontmatter(
        { status: 'READY', tested_commit: testedCommit },
        '# Product QA\n\nStatus: READY\n',
      ),
    );

    const result = await finishWorkflow(root, runtime);

    expect(result.ok, result.message).toBe(true);
    expect(readManifest(paths)!.milestones[0]!.status).toBe('COMPLETE');
  });

  it('finish refuses a requirement that has evidence but is not resolved', async () => {
    const runtime = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, runtime);
    await startWorkflow(root, runtime);
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === manifest.active_milestone,
    )!;
    const milestoneDir = paths.milestoneDir(milestone.id, milestone.slug);
    const requirementsPath = path.join(milestoneDir, 'REQUIREMENTS.md');
    const requirements = readRequirements(requirementsPath);
    requirements.requirements[0]!.status = 'BLOCKED';
    requirements.requirements[0]!.evidence = 'Recorded partial evidence.';
    writeRequirements(requirementsPath, requirements);
    fs.writeFileSync(
      path.join(milestoneDir, 'qa', 'production-readiness.md'),
      serializeFrontmatter(
        { status: 'NOT_READY', tested_commit: runtime.git.headCommit(root) },
        '# Product QA\n\nStatus: NOT_READY\n',
      ),
    );

    const result = await finishWorkflow(root, runtime);

    expect(result.status).toBe('blocked');
    expect(result.message).toContain('unresolved requirements');
    expect(fs.existsSync(path.join(milestoneDir, 'CLOSEOUT.md'))).toBe(false);
  });

  it('finish registers a native host closeout when the portable manifest is still active', async () => {
    const runtime = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, runtime);
    await startWorkflow(root, runtime);
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const milestone = manifest.milestones.find(
      (candidate) => candidate.id === manifest.active_milestone,
    )!;
    const milestoneDir = paths.milestoneDir(milestone.id, milestone.slug);
    fs.writeFileSync(
      path.join(milestoneDir, 'qa', 'production-readiness.md'),
      serializeFrontmatter(
        { status: 'READY', tested_commit: runtime.git.headCommit(root) },
        '# Product QA\n\nStatus: READY\n',
      ),
    );
    fs.writeFileSync(
      path.join(milestoneDir, 'CLOSEOUT.md'),
      serializeFrontmatter(
        { milestone: milestone.id, status: 'SEALED' },
        `# Closeout — ${milestone.id}\n\nThe native host wrote this report.\n`,
      ),
    );
    runtime.git.dirty = [
      path.relative(root, path.join(milestoneDir, 'CLOSEOUT.md')),
    ];

    const result = await finishWorkflow(root, runtime);

    expect(result.ok, result.message).toBe(true);
    expect(result.message).toContain('sealed with QA result READY');
    expect(readManifest(paths)!.milestones[0]!.status).toBe('COMPLETE');
    expect(fs.readFileSync(path.join(milestoneDir, 'CLOSEOUT.md'), 'utf8')).toContain(
      'The native host wrote this report.',
    );
    expect(fs.readFileSync(paths.milestonesIndex, 'utf8')).toContain(
      `| ${milestone.id} | ${milestone.slug} | COMPLETE |`,
    );
    expect(runtime.git.dirty).toEqual([]);
    expect(runtime.git.tags).toEqual(['rijo/M001']);

    const repeated = await finishWorkflow(root, runtime);
    expect(repeated.ok, repeated.message).toBe(true);
    expect(repeated.message).toContain('already sealed');
    expect(runtime.git.tags).toEqual(['rijo/M001']);
  });
});
