import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeFrontmatter } from '../src/core/frontmatter.js';
import { readManifest } from '../src/core/manifest.js';
import { RijoPaths } from '../src/core/paths.js';
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
});
