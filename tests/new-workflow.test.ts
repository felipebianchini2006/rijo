import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRequirements, readRoadmap } from '../src/core/roadmap.js';
import { readState } from '../src/core/state.js';
import { tmpProject, cleanup, writePlanFile, deps } from './helpers.js';

describe('rijo new (greenfield)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('creates full context, requirements, roadmap and state from a PLAN.md', async () => {
    const d = deps(root);
    const outcome = await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    expect(outcome.ok).toBe(true);

    const paths = new RijoPaths(root);
    for (const p of [paths.config, paths.manifest, paths.project, paths.rules, paths.stack, paths.milestonesIndex, paths.state, paths.decisions]) {
      expect(fs.existsSync(p), p).toBe(true);
    }
    const manifest = readManifest(paths)!;
    expect(manifest.active_milestone).toBe('M001');
    expect(manifest.milestones[0]).toMatchObject({ id: 'M001', status: 'ACTIVE' });

    const mdir = paths.milestoneDir('M001', manifest.milestones[0]!.slug);
    const reqs = readRequirements(path.join(mdir, 'REQUIREMENTS.md'));
    expect(reqs.requirements).toHaveLength(2);
    expect(reqs.requirements[0]!.id).toBe('M001-REQ-001');
    expect(reqs.requirements.every((r) => r.phase !== null)).toBe(true);

    const roadmap = readRoadmap(path.join(mdir, 'ROADMAP.md'));
    expect(roadmap.phases.map((p) => p.id)).toEqual(['01', '02']);
    expect(roadmap.phases[1]!.depends_on).toEqual(['01']);

    const state = readState(paths)!;
    expect(state.milestone).toBe('M001');
    expect(fs.existsSync(path.join(mdir, 'SCOPE.md'))).toBe(true);
    expect(fs.existsSync(path.join(mdir, 'RESEARCH.md'))).toBe(true);
  });

  it('refuses re-initialization without --next (non-destructive)', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const before = fs.readFileSync(new RijoPaths(root).manifest, 'utf8');
    const second = await newWorkflow(root, { planFile: '@PLANO.md' }, deps(root));
    expect(second.ok).toBe(false);
    expect(second.status).toBe('blocked');
    expect(second.details?.join(' ')).toContain('--next');
    expect(fs.readFileSync(new RijoPaths(root).manifest, 'utf8')).toBe(before);
  });

  it('fails when the plan file does not exist', async () => {
    const outcome = await newWorkflow(root, { planFile: '@MISSING.md' }, deps(root));
    expect(outcome.status).toBe('failed');
  });

  it('records research sources for volatile decisions', async () => {
    await newWorkflow(root, { planFile: '@PLANO.md' }, deps(root));
    const paths = new RijoPaths(root);
    const sources = JSON.parse(fs.readFileSync(paths.researchSources, 'utf8'));
    expect(sources.sources.length).toBeGreaterThan(0);
    expect(sources.sources[0]).toMatchObject({ url: expect.stringContaining('nodejs.org') });
    const cache = JSON.parse(fs.readFileSync(paths.researchCache, 'utf8'));
    expect(cache.entries[0]!.key).toBe('node-lts');
  });
});

describe('rijo new (brownfield)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
    // existing codebase with detectable stack and commands
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, 'src', `mod${i}.ts`), `export const x${i} = ${i};\n`);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'legacy-app', scripts: { build: 'tsc', test: 'vitest run' }, dependencies: { express: '^4.0.0' } }),
    );
  });
  afterEach(() => cleanup(root));

  it('detects stack and commands without rewriting the project', async () => {
    const d = deps(root);
    const outcome = await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    expect(outcome.ok).toBe(true);
    const stack = fs.readFileSync(new RijoPaths(root).stack, 'utf8');
    expect(stack).toContain('BROWNFIELD');
    expect(stack).toContain('express');
    expect(stack).toContain('npm run build');
    // existing source untouched
    expect(fs.readFileSync(path.join(root, 'src', 'mod0.ts'), 'utf8')).toBe('export const x0 = 0;\n');
    // extraction task received brownfield context
    const extract = d.runner.executed.find((t) => t.id === 'new-extract')!;
    expect(extract.notes).toContain('BROWNFIELD');
  });
});
