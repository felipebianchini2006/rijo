import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  findExplicitLoopbackBaseUrl,
  newWorkflow,
  validatePlanExtractionFidelity,
} from '../src/workflows/new.js';
import { RijoPaths } from '../src/core/paths.js';
import { newManifest, readManifest, writeManifest } from '../src/core/manifest.js';
import { readRequirements, readRoadmap } from '../src/core/roadmap.js';
import { readState } from '../src/core/state.js';
import { defaultConfig, loadConfig, saveConfig } from '../src/core/config.js';
import { tmpProject, cleanup, writePlanFile, deps, EXTRACTION_PAYLOAD } from './helpers.js';

it('rejects extraction that omits an explicit phase count or dependency', () => {
  const plan = [
    'Implement in exactly two sequential phases.',
    'Phase 01 — Increment.',
    'Phase 02 — Decrement.',
    'Phase 02 depends on phase 01.',
  ].join('\n');
  expect(
    validatePlanExtractionFidelity(plan, {
      ...EXTRACTION_PAYLOAD,
      phases: [EXTRACTION_PAYLOAD.phases[0]!],
    }),
  ).toContain('phases: plan explicitly requires 2, but extraction returned 1');
  expect(
    validatePlanExtractionFidelity(plan, {
      ...EXTRACTION_PAYLOAD,
      phases: EXTRACTION_PAYLOAD.phases.map((phase) => ({ ...phase, depends_on_indexes: [] })),
    }),
  ).toContain('phases.1.depends_on_indexes: plan explicitly requires dependency on phase 1');
});

describe('rijo new (greenfield)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('creates full context, requirements, roadmap and state from a PLAN.md', async () => {
    const d = deps(root);
    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, d);
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

  it('preserves a valid preconfigured runtime instead of replacing it with defaults', async () => {
    const paths = new RijoPaths(root);
    const configured = defaultConfig();
    configured.context_budget_bytes = 12_345;
    saveConfig(paths, configured);

    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, deps(root));

    expect(outcome.ok).toBe(true);
    expect(loadConfig(paths).context_budget_bytes).toBe(12_345);
  });

  it('materializes an explicit loopback endpoint and all required web viewports', async () => {
    fs.appendFileSync(
      path.join(root, 'PLAN.md'),
      '\nServe the application at http://127.0.0.1:4173.\n',
    );

    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, deps(root))).ok).toBe(true);

    const config = loadConfig(new RijoPaths(root));
    expect(config.qa.surface).toBe('web');
    expect(config.qa.base_url).toBe('http://127.0.0.1:4173');
    expect(config.qa.viewports.map((viewport) => viewport.name)).toEqual([
      'desktop',
      'tablet',
      'mobile',
    ]);
  });

  it('feeds exact PlanExtraction schema errors into the bounded correction attempt', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'new-extract',
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'invalid first extraction',
        files_written: [],
        payload: {
          project_name: 'Fixture',
          project_summary: 'Fixture summary',
          requirements: [{ description: 'Requirement', acceptance: 'Accepted', non_functional: false }],
          phases: [{ name: 'Phase', requirement_indexes: ['not-a-number'], ui_surface: false }],
        },
        scope_requests: [],
      }),
    );
    d.runner.on(
      (task) => task.id.startsWith('new-extract-r'),
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'corrected extraction',
        files_written: [],
        payload: EXTRACTION_PAYLOAD,
        scope_requests: [],
      }),
    );

    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    expect(outcome.ok, outcome.message).toBe(true);
    const correction = d.runner.executed.find((task) => task.id === 'new-extract-r1');
    expect(correction?.notes).toContain('CORRECT THESE EXACT ERRORS');
    expect(correction?.notes).toContain('phases.0.requirement_indexes.0');
  });

  it('uses a fresh bounded correction task for an invalid roadmap payload', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'new-roadmap',
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'invalid roadmap',
        files_written: [],
        payload: {
          phases: [{
            name: 'Invalid phase',
            requirement_indexes: ['invalid-index'],
            depends_on_indexes: [],
            ui_surface: 'web',
          }],
        },
        scope_requests: [],
      }),
    );
    d.runner.on(
      (task) => task.id === 'new-roadmap-r1',
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'corrected roadmap',
        files_written: [],
        payload: {
          phases: EXTRACTION_PAYLOAD.phases,
          rationale: 'Use the two observable vertical slices from the approved scope.',
        },
        scope_requests: [],
      }),
    );

    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    expect(outcome.ok, outcome.message).toBe(true);
    const correction = d.runner.executed.find((task) => task.id === 'new-roadmap-r1');
    expect(correction?.notes).toContain('CORRECT THESE EXACT ERRORS');
    expect(correction?.notes).toContain('phases.0.requirement_indexes.0');
    expect(correction?.notes).toContain('rationale');
  });

  it('refuses re-initialization without --next (non-destructive)', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const before = fs.readFileSync(new RijoPaths(root).manifest, 'utf8');
    const second = await newWorkflow(root, { planFile: '@PLAN.md' }, deps(root));
    expect(second.ok).toBe(false);
    expect(second.status).toBe('blocked');
    expect(second.details?.join(' ')).toContain('--next');
    expect(fs.readFileSync(new RijoPaths(root).manifest, 'utf8')).toBe(before);
  });

  it('resumes setup when the manifest has no milestone', async () => {
    const paths = new RijoPaths(root);
    fs.mkdirSync(paths.root, { recursive: true });
    writeManifest(paths, newManifest(() => new Date('2026-07-27T00:00:00.000Z')));

    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, deps(root));

    expect(outcome.ok, outcome.message).toBe(true);
    const manifest = readManifest(paths)!;
    expect(manifest.active_milestone).toBe('M001');
    expect(manifest.milestones).toHaveLength(1);
  });

  it('fails when the plan file does not exist', async () => {
    const outcome = await newWorkflow(root, { planFile: '@MISSING.md' }, deps(root));
    expect(outcome.status).toBe('failed');
  });

  it('records research sources for volatile decisions', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const paths = new RijoPaths(root);
    const sources = JSON.parse(fs.readFileSync(paths.researchSources, 'utf8'));
    expect(sources.sources.length).toBeGreaterThan(0);
    expect(sources.sources[0]).toMatchObject({ url: expect.stringContaining('nodejs.org') });
    const cache = JSON.parse(fs.readFileSync(paths.researchCache, 'utf8'));
    expect(cache.entries).toHaveLength(3);
    expect(cache.entries.map((entry: { key: string }) => entry.key)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^project-stack-/),
        expect.stringMatching(/^project-architecture-/),
        expect.stringMatching(/^project-risks-/),
      ]),
    );
    const researchTask = d.runner.executed.find((task) => task.id === 'new-research-1')!;
    expect(researchTask.return_format).toContain('confidence: high|medium|low');
    expect(researchTask.return_format).toContain('checked_at: ISO-8601 string');
    expect(d.runner.executed.filter((task) => task.id.startsWith('new-research-'))).toHaveLength(3);
    expect(d.runner.executed.find((task) => task.id === 'new-roadmap')).toBeDefined();
  });

  it('normalizes a numeric research confidence score', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'new-research-1',
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'Official Node.js source checked.',
        files_written: [],
        payload: {
          summary: 'Node.js 24 is an active Long-Term Support release.',
          sources: [{
            claim: 'Node.js 24 is active Long-Term Support.',
            source: 'Node.js releases',
            url: 'https://nodejs.org/en/about/previous-releases',
            checked_at: '2026-07-27T00:00:00.000Z',
            version: '24.18.0',
            confidence: 1,
            tier: 'official',
          }],
        },
        scope_requests: [],
      }),
    );

    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    expect(outcome.ok, outcome.message).toBe(true);
    const sources = JSON.parse(
      fs.readFileSync(new RijoPaths(root).researchSources, 'utf8'),
    ) as { sources: Array<{ confidence: string }> };
    expect(sources.sources[0]!.confidence).toBe('high');
  });
});

it('accepts only valid explicit loopback ports for project QA', () => {
  expect(findExplicitLoopbackBaseUrl('Open http://localhost:4173/path.')).toBe('http://localhost:4173');
  expect(findExplicitLoopbackBaseUrl('Open http://127.0.0.1:70000.')).toBeNull();
  expect(findExplicitLoopbackBaseUrl('Open https://example.com:4173.')).toBeNull();
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

  it('requires an explicit codebase map without rewriting the project', async () => {
    const d = deps(root);
    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe(
      'Run `$rijo map-codebase`, then run `$rijo new @PLAN.md` again.',
    );
    expect(fs.existsSync(new RijoPaths(root).codebaseMapState)).toBe(false);
    // existing source untouched
    expect(fs.readFileSync(path.join(root, 'src', 'mod0.ts'), 'utf8')).toBe('export const x0 = 0;\n');
    expect(d.runner.executed).toHaveLength(0);
  });
});
