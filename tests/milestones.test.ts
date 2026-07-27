import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRequirements } from '../src/core/roadmap.js';
import { tmpProject, cleanup, writePlanFile, deps, EXTRACTION_PAYLOAD } from './helpers.js';

const M2_EXTRACTION = {
  ...EXTRACTION_PAYLOAD,
  project_name: 'Payments and Subscriptions',
  requirements: [
    { description: 'Recurring subscription', acceptance: 'User starts a monthly subscription', non_functional: false, classification: 'NEW' },
  ],
  phases: [{ name: 'Subscriptions', requirement_indexes: [0], depends_on_indexes: [], ui_surface: false }],
  research_topics: [{ key: 'node-lts', topic: 'Recommended Node.js LTS', volatile: true }],
};

describe('milestone cycle', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
    writePlanFile(root, 'PLAN-2.md', '# Plan M002\n\nPayments and subscriptions.\n');
  });
  afterEach(() => cleanup(root));

  it('seals a completed M001 as COMPLETE and M001 stays unchanged after M002 exists', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, { target: 'all' }, d); // completes all requirements

    const paths = new RijoPaths(root);
    const m1dir = paths.milestoneDir('M001', readManifest(paths)!.milestones[0]!.slug);
    const scopeBefore = fs.readFileSync(path.join(m1dir, 'SCOPE.md'), 'utf8');
    const roadmapBefore = fs.readFileSync(path.join(m1dir, 'ROADMAP.md'), 'utf8');

    const headBeforeNext = d.git.headCommit()!;
    const d2 = { ...deps(root, { extraction: M2_EXTRACTION }), git: d.git };
    const outcome = await newWorkflow(root, { planFile: '@PLAN-2.md', next: true }, d2);
    expect(outcome.ok, outcome.message).toBe(true);

    const manifest = readManifest(paths)!;
    expect(manifest.active_milestone).toBe('M002');
    expect(manifest.milestones.find((m) => m.id === 'M001')!.status).toBe('COMPLETE');
    // historic artifacts immutable (closeout added, existing files untouched)
    expect(fs.readFileSync(path.join(m1dir, 'SCOPE.md'), 'utf8')).toBe(scopeBefore);
    expect(fs.readFileSync(path.join(m1dir, 'ROADMAP.md'), 'utf8')).toBe(roadmapBefore);
    expect(fs.existsSync(path.join(m1dir, 'CLOSEOUT.md'))).toBe(true);
    // baseline commit recorded (the HEAD at seal time, before M002's baseline commit)
    expect(fs.readFileSync(path.join(m1dir, 'CLOSEOUT.md'), 'utf8')).toContain(headBeforeNext);
    // git tag created locally, never pushed (FakeGit only records)
    expect(d2.git.tags).toContain('rijo/M001');
  });

  it('closes an incomplete milestone as PARTIAL, never COMPLETE, and carries requirements with carried_from', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d); // requirements stay PENDING (no run)

    const d2 = deps(root, { extraction: M2_EXTRACTION });
    const outcome = await newWorkflow(root, { planFile: '@PLAN-2.md', next: true }, d2);
    expect(outcome.ok, outcome.message).toBe(true);

    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    expect(manifest.milestones.find((m) => m.id === 'M001')!.status).toBe('PARTIAL');

    // M001 requirements were classified as CARRIED
    const m1 = readRequirements(path.join(paths.milestoneDir('M001', manifest.milestones[0]!.slug), 'REQUIREMENTS.md'));
    expect(m1.requirements.every((r) => r.status === 'CARRIED')).toBe(true);

    // M002 contains the carryovers with fresh namespaced IDs and carried_from pointers
    const m2 = readRequirements(path.join(paths.milestoneDir('M002', manifest.milestones[1]!.slug), 'REQUIREMENTS.md'));
    const carried = m2.requirements.filter((r) => r.classification === 'CARRYOVER');
    expect(carried).toHaveLength(2);
    expect(carried[0]!.carried_from).toBe('M001-REQ-001');
    expect(carried.every((r) => r.id.startsWith('M002-REQ-'))).toBe(true);
    // no ID collision across milestones
    const allIds = [...m1.requirements.map((r) => r.id), ...m2.requirements.map((r) => r.id)];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('blocks --next when unknown local changes exist (never discards or stashes)', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const d2 = deps(root, { extraction: M2_EXTRACTION });
    d2.git.dirty = ['src/unknown-edit.ts'];
    const outcome = await newWorkflow(root, { planFile: '@PLAN-2.md', next: true }, d2);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('never be discarded');
  });

  it('delta research reuses the cache on the next milestone', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, { target: 'all' }, d);
    const d2 = deps(root, { extraction: M2_EXTRACTION });
    await newWorkflow(root, { planFile: '@PLAN-2.md', next: true }, d2);
    // same research key was cached in M001 → no researcher spawned in M002
    expect(d2.runner.executed.filter((t) => t.id.startsWith('new-research'))).toHaveLength(0);
  });

  it('blocks --next when an execution checkpoint is open', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id === 'exec-01-T02',
      (t) => ({ task_id: t.id, ok: false, summary: 'interrupted', files_written: [], payload: null, scope_requests: [] }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, {}, d); // blocks mid-phase, checkpoint stays open at EXECUTE
    const d2 = deps(root, { extraction: M2_EXTRACTION });
    const outcome = await newWorkflow(root, { planFile: '@PLAN-2.md', next: true }, d2);
    expect(outcome.status).toBe('blocked');
    expect(outcome.details?.join(' ')).toContain('rijo run');
  });
});
