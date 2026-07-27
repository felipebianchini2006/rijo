import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readPlan } from '../src/core/plan.js';
import { readState } from '../src/core/state.js';
import { tmpProject, cleanup, writePlanFile, deps, newMappedReference, ok, phaseReqIds } from './helpers.js';

function milestoneDir(root: string): string {
  const paths = new RijoPaths(root);
  const manifest = readManifest(paths)!;
  const m = manifest.milestones.find((x) => x.id === manifest.active_milestone)!;
  return paths.milestoneDir(m.id, m.slug);
}

/** Two parallel tasks with disjoint scopes (src/a.ts vs src/b.ts). */
function parallelPlan(root: string) {
  return (phaseId: string) => ({
    phase: phaseId,
    tasks: [
      { id: 'T01', name: 'a', requirement_ids: phaseReqIds(root, phaseId), technical_justification: null, files: ['src/a.ts'], mapped_references: [newMappedReference('src/a.ts')], write_scope: ['src/a.ts'], depends_on: [], parallel: true, tdd: false, tests: ['echo ok'], evidence_expected: 'e', done: false },
      { id: 'T02', name: 'b', requirement_ids: [], technical_justification: 'x', files: ['src/b.ts'], mapped_references: [newMappedReference('src/b.ts')], write_scope: ['src/b.ts'], depends_on: [], parallel: true, tdd: false, tests: [], evidence_expected: 'e', done: false },
    ],
  });
}

describe('per-attempt isolation (workflow level)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-iso-');
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('worker A cannot write into worker B\'s scope', async () => {
    const d = deps(root, { planPayload: parallelPlan(root) });
    d.runner.on(
      (t) => t.id === 'exec-01-T01',
      (t) => {
        const base = t.workspace!.root;
        fs.mkdirSync(path.join(base, 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'src', 'a.ts'), '// A in scope\n');
        fs.writeFileSync(path.join(base, 'src', 'b.ts'), '// A INVADING B SCOPE\n');
        return ok(t, { files_written: ['src/a.ts'], payload: { done: true, notes: '' } });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/outside its individual write scope/);
    // B's scope in the checkout was never touched by A
    expect(fs.existsSync(path.join(root, 'src', 'b.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'a.ts'))).toBe(false);
  });

  it('a worker that edits and then returns an error leaves zero changes', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id === 'exec-01-T01',
      (t) => {
        const base = t.workspace!.root;
        fs.mkdirSync(path.join(base, 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'src', 'a.ts'), '// edited before failing\n');
        return { task_id: t.id, ok: false, summary: 'crashed after editing', files_written: [], payload: null, scope_requests: [] };
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(fs.existsSync(path.join(root, 'src', 'a.ts'))).toBe(false);
    // no orphan workspace remains
    const wsDir = path.join(root, '.rijo', 'runtime', 'workspaces');
    expect(!fs.existsSync(wsDir) || fs.readdirSync(wsDir).length === 0).toBe(true);
  });

  it('a worker cannot modify .rijo/RULES.md without authorization', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id === 'exec-01-T01',
      (t) => {
        const base = t.workspace!.root;
        fs.mkdirSync(path.join(base, 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'src', 'a.ts'), '// legit\n');
        fs.writeFileSync(path.join(base, '.rijo', 'RULES.md'), '# corrupted rules\n');
        return ok(t, { files_written: ['src/a.ts'], payload: { done: true, notes: '' } });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const rulesBefore = fs.readFileSync(path.join(root, '.rijo', 'RULES.md'), 'utf8');
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/canonical .rijo files/);
    expect(fs.readFileSync(path.join(root, '.rijo', 'RULES.md'), 'utf8')).toBe(rulesBefore);
    expect(fs.existsSync(path.join(root, 'src', 'a.ts'))).toBe(false);
  });

  it('a concurrent user change blocks the patch apply explicitly', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id === 'exec-01-T01',
      (t) => {
        const base = t.workspace!.root;
        fs.mkdirSync(path.join(base, 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'src', 'a.ts'), '// attempt version\n');
        // the user concurrently creates the same file in the checkout
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// user version\n');
        return ok(t, { files_written: ['src/a.ts'], payload: { done: true, notes: '' } });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/changed concurrently|NOT applied/);
    // the user's version survives untouched
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('// user version\n');
  });

  it('two parallel workers with disjoint files both land; each ran in its own workspace', async () => {
    const seenRoots: string[] = [];
    const d = deps(root, { planPayload: parallelPlan(root) });
    d.runner.on(
      (t) => t.role === 'worker' && t.id.startsWith('exec-'),
      (t) => {
        seenRoots.push(t.workspace!.root);
        const base = t.workspace!.root;
        const scope = t.write_scope[0]!;
        fs.mkdirSync(path.dirname(path.join(base, scope)), { recursive: true });
        fs.writeFileSync(path.join(base, scope), `// ${t.id}\n`, 'utf8');
        return ok(t, { files_written: [scope], payload: { done: true, notes: '' } });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src', 'b.ts'))).toBe(true);
    // one workspace per attempt, never shared
    expect(new Set(seenRoots).size).toBe(seenRoots.length);
  });

  it('attempt 2 starts from a clean baseline after attempt 1 failed', async () => {
    let attempt = 0;
    const d = deps(root);
    d.runner.on(
      (t) => t.id === 'exec-01-T01',
      (t) => {
        attempt++;
        const base = t.workspace!.root;
        if (attempt === 1) {
          fs.mkdirSync(path.join(base, 'src'), { recursive: true });
          fs.writeFileSync(path.join(base, 'src', 'a.ts'), '// garbage from attempt 1\n');
          return { task_id: t.id, ok: false, summary: 'failed after editing', files_written: [], payload: null, scope_requests: [] };
        }
        // attempt 2 must NOT see attempt 1's garbage
        expect(fs.existsSync(path.join(base, 'src', 'a.ts'))).toBe(false);
        fs.mkdirSync(path.join(base, 'src'), { recursive: true });
        fs.writeFileSync(path.join(base, 'src', 'a.ts'), '// clean attempt 2\n');
        return ok(t, { files_written: ['src/a.ts'], payload: { done: true, notes: '' } });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const first = await runWorkflow(root, {}, d);
    expect(first.status).toBe('blocked');
    const second = await runWorkflow(root, {}, d);
    expect(second.ok, second.message).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('// clean attempt 2\n');
  });

  it('a checkout with a symlink escaping the project root blocks before any attempt runs', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'victim.txt'), 'host secret\n');
      const d = deps(root);
      await newWorkflow(root, { planFile: '@PLAN.md' }, d);
      // the operator (or a previous attempt) leaves a door out of the checkout
      fs.symlinkSync(path.join(outside, 'victim.txt'), path.join(root, 'leak.txt'));
      let dispatched = false;
      d.runner.on(
        (t) => t.id === 'exec-01-T01',
        (t) => {
          dispatched = true;
          return ok(t, { files_written: [], payload: { done: true, notes: '' } });
        },
      );
      const outcome = await runWorkflow(root, {}, d);
      expect(outcome.status).toBe('blocked');
      expect(outcome.message).toMatch(/symlinks whose target is absolute or leaves the project root/);
      expect(outcome.message).toContain('leak.txt');
      expect(dispatched).toBe(false);
      expect(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8')).toBe('host secret\n');
    } finally {
      cleanup(outside);
    }
  });

  it('a read-only reviewer that writes to the checkout blocks the phase', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id.startsWith('code-review-'),
      (t) => {
        // rogue reviewer writes straight into the checkout
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'rogue.ts'), '// reviewer should be read-only\n');
        return ok(t, { payload: { approved: true, findings: [] } });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/read-only.*modified the checkout/);
  });
});

describe('task lifecycle interruption at each transition', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-lc-');
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('interruption during EXECUTE (dispatch throws) leaves tasks FAILED and STATE without an unverified checkpoint', async () => {
    const d = deps(root);
    d.runner.on(
      (t) => t.id === 'exec-01-T01',
      () => {
        throw new Error('host connection lost');
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    const planPath = path.join(milestoneDir(root), 'phases', '01-catalog', 'PLAN.md');
    const plan = readPlan(planPath);
    expect(plan.tasks.find((t) => t.id === 'T01')!.status).toBe('FAILED');
    expect(plan.tasks.every((t) => !t.done)).toBe(true);
    // STATE.md never recorded an unverified EXECUTE checkpoint for this phase
    const state = readState(new RijoPaths(root));
    expect(state?.last_verified ?? null).toBeNull();
  });

  it('interruption during VERIFY leaves tasks VERIFYING; resume re-verifies instead of promoting', async () => {
    const d = deps(root);
    // first run: verification fails both rounds → blocked with tasks unverified
    let failVerify = true;
    const shell = {
      run(command: string) {
        return {
          command,
          exit_code: failVerify && /echo test-a/.test(command) ? 1 : 0,
          summary: '',
          duration_ms: 1,
          blocked: false,
          category: 'test' as const,
        };
      },
    };
    const d2 = { ...d, shell };
    await newWorkflow(root, { planFile: '@PLAN.md' }, d2);
    const first = await runWorkflow(root, {}, d2);
    expect(first.status).toBe('blocked');
    const planPath = path.join(milestoneDir(root), 'phases', '01-catalog', 'PLAN.md');
    const mid = readPlan(planPath);
    // implemented but NEVER promoted to done without verification
    expect(mid.tasks.every((t) => !t.done)).toBe(true);
    expect(mid.tasks.some((t) => t.status === 'VERIFYING' || t.status === 'IMPLEMENTED')).toBe(true);

    failVerify = false;
    const second = await runWorkflow(root, {}, d2);
    expect(second.ok, second.message).toBe(true);
    const final = readPlan(planPath);
    expect(final.tasks.every((t) => t.status === 'DONE')).toBe(true);
  });

  it('every transition writes an append-only event BEFORE the plan projection', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, {}, d);
    const events = fs
      .readFileSync(path.join(root, '.rijo', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'task.transition');
    // the full verified lifecycle of T01 is in the audit log, in order
    const t01 = events.filter((e) => e.data.task === 'T01').map((e) => e.data.to);
    expect(t01).toEqual(['RUNNING', 'IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE']);
  });

  it('a requirement only becomes DONE with task, test, review and evidence linked', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, {}, d);
    const reqsRaw = fs.readFileSync(path.join(milestoneDir(root), 'REQUIREMENTS.md'), 'utf8');
    expect(reqsRaw).toContain('status: DONE');
    expect(reqsRaw).toContain('review approved');
    expect(reqsRaw).toContain('VERIFICATION.md');
  });
});
