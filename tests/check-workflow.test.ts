import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { checkWorkflow, testWorkflow } from '../src/workflows/check.js';
import { openQaCheckpoint } from '../src/workflows/qa-checkpoint.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { decideReadiness } from '../src/qa/readiness.js';
import { deriveJourneys } from '../src/qa/journeys.js';
import { RequirementSchema } from '../src/core/schemas/index.js';
import { tmpProject, cleanup, writePlanFile, deps, ok } from './helpers.js';

/** A project whose gates can pass: a build/test script and a passing ui-smoke. */
function prepareReadyProject(root: string, d: ReturnType<typeof deps>) {
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'app', scripts: { build: 'echo build', test: 'echo test' } }),
  );
  d.runner.on(
    (t) => t.id.startsWith('ui-smoke-'),
    (t) => ok(t, { payload: { passed: true, console_errors: [], network_errors: [], screenshot: null, notes: '' } }),
  );
}

function readinessPath(root: string): string {
  const paths = new RijoPaths(root);
  const manifest = readManifest(paths)!;
  const m = manifest.milestones.find((x) => x.id === manifest.active_milestone)!;
  return path.join(paths.milestoneDir(m.id, m.slug), 'qa', 'production-readiness.md');
}

function wireJourneys(d: ReturnType<typeof deps>, result: (journeyId: string) => Record<string, unknown>) {
  d.runner.on(
    (t) => t.id.startsWith('journey-'),
    (t) => {
      const id = t.id.replace('journey-', '');
      return ok(t, { payload: { journey_id: id, passed: true, steps: ['login', 'flow'], console_errors: [], network_errors: [], findings: [], screenshots: [], ...result(id) } });
    },
  );
}

describe('rijo check', () => {
  let root: string;
  beforeEach(async () => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('is BLOCKED when browser capability is missing — never READY by inference', async () => {
    const d = deps(root); // browser: false
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('status: BLOCKED');
    expect(report).toContain('browser');
  });

  it('all valid gates produce READY with pinned commit and evidence', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    prepareReadyProject(root, d);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, { target: 'all' }, d); // requirements become DONE
    wireJourneys(d, () => ({}));
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message + ' :: ' + (outcome.details ?? []).join(' | ')).toBe(true);
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('status: READY');
    expect(report).toContain(d.git.headCommit()!);
    expect(report).toContain('## Journeys');
  });

  it('native QA commits the verified repair set and records its exact commit', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    prepareReadyProject(root, d);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, { target: 'all' }, d);
    wireJourneys(d, () => ({}));

    const opened = openQaCheckpoint(root, d.git);
    expect(opened.resumed).toBe(false);
    fs.writeFileSync(path.join(root, 'qa-repair.txt'), 'verified repair\n');

    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);
    const tested = d.git.commits.find((item) =>
      item.message.includes('verified product QA checkpoint'),
    );
    expect(tested?.paths).toContain('qa-repair.txt');
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain(`tested_commit: ${tested!.hash}`);
    expect(report).toContain('evidence_commit: fake');
    expect(fs.existsSync(new RijoPaths(root).qaCheckpoint)).toBe(false);
  });

  it('a console error in a critical flow prevents READY', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    wireJourneys(d, (id) => (id === 'J01' ? { console_errors: ['TypeError: cannot read products'] } : {}));
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok).toBe(false);
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('status: NOT_READY');
    expect(report).toContain('console errors');
  });

  it('a 5xx network error prevents READY', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    wireJourneys(d, (id) => (id === 'J02' ? { network_errors: ['POST /api/checkout → 500'] } : {}));
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok).toBe(false);
    expect(fs.readFileSync(readinessPath(root), 'utf8')).toContain('Network errors');
  });

  it('a relevant visual finding appears in the report', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    wireJourneys(d, () => ({}));
    d.runner.on(
      (t) => t.id === 'check-visual',
      (t) => ok(t, { payload: { findings: [{ severity: 'high', description: 'checkout button is misaligned on mobile', evidence: null }] } }),
    );
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok).toBe(false);
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('checkout button is misaligned on mobile');
    expect(report).toContain('[high]');
  });

  it('--fix records defects and runs a complete regression pass after repair', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    prepareReadyProject(root, d);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, { target: 'all' }, d);
    let fixed = false;
    d.runner.on(
      (t) => t.id.startsWith('journey-'),
      (t) => {
        const id = t.id.replace('journey-', '');
        const failing = id === 'J01' && !fixed;
        return ok(t, {
          payload: {
            journey_id: id, passed: !failing, steps: [], console_errors: [], network_errors: [],
            findings: failing ? [{ severity: 'high', description: 'search does not return results', evidence: null }] : [],
            screenshots: [],
          },
        });
      },
    );
    d.runner.on(
      (t) => t.id.startsWith('check-fix-'),
      (t) => {
        fixed = true;
        return ok(t, { payload: { done: true, notes: 'root cause repaired' } });
      },
    );
    const outcome = await checkWorkflow(root, { fix: true }, d);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(d.runner.executed.filter((t) => t.id.startsWith('check-fix-'))).toHaveLength(1);
    // Every journey runs again after a repair.
    expect(d.runner.executed.filter((t) => t.id.startsWith('journey-'))).toHaveLength(4);
    const results = path.join(new RijoPaths(root).qaDir, 'test-results');
    expect(fs.existsSync(path.join(results, 'J01', 'PASS-01.json'))).toBe(true);
    expect(fs.existsSync(path.join(results, 'J01', 'PASS-02.json'))).toBe(true);
    expect(fs.existsSync(path.join(results, 'J02', 'PASS-02.json'))).toBe(true);
  });

  it('test repairs defects by default and still executes every journey', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    prepareReadyProject(root, d);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, { target: 'all' }, d);
    let repaired = false;
    d.runner.on(
      (t) => t.id.startsWith('journey-'),
      (t) => {
        const id = t.id.replace(/-pass-\d+$/, '').replace('journey-', '');
        const failing = id === 'J01' && !repaired;
        return ok(t, {
          payload: {
            journey_id: id,
            passed: !failing,
            steps: ['open', 'submit'],
            console_errors: [],
            network_errors: [],
            findings: failing
              ? [{ severity: 'high', description: 'submit fails', evidence: null }]
              : [],
            screenshots: [],
          },
        });
      },
    );
    d.runner.on(
      (t) => t.id.startsWith('check-fix-'),
      (t) => {
        repaired = true;
        return ok(t, { payload: { done: true, notes: 'submit repaired' } });
      },
    );

    const outcome = await testWorkflow(root, {}, d);

    expect(outcome.ok, outcome.message).toBe(true);
    expect(d.runner.executed.filter((t) => t.id.startsWith('check-fix-'))).toHaveLength(1);
    expect(d.runner.executed.filter((t) => t.id.startsWith('journey-'))).toHaveLength(4);
  });

  it('returns NOT_READY after the defect and regression budgets are exhausted', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    prepareReadyProject(root, d);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    await runWorkflow(root, { target: 'all' }, d);
    d.runner.on(
      (t) => t.id.startsWith('journey-'),
      (t) => {
        const id = t.id.replace(/-pass-\d+$/, '').replace('journey-', '');
        const failing = id === 'J01';
        return ok(t, {
          payload: {
            journey_id: id,
            passed: !failing,
            steps: ['open', 'submit'],
            console_errors: [],
            network_errors: [],
            findings: failing
              ? [{ severity: 'high', description: 'persistent submit failure', evidence: null }]
              : [],
            screenshots: [],
          },
        });
      },
    );
    d.runner.on(
      (t) => t.id.startsWith('check-fix-'),
      (t) => ok(t, { payload: { done: true, notes: 'attempted repair' } }),
    );

    const outcome = await testWorkflow(root, {}, d);

    expect(outcome.status).toBe('not_ready');
    expect(d.runner.executed.filter((t) => t.id.startsWith('check-fix-'))).toHaveLength(2);
    expect(d.runner.executed.filter((t) => t.id.startsWith('journey-'))).toHaveLength(6);
    expect(fs.readFileSync(readinessPath(root), 'utf8')).toContain('persistent submit failure');
  });
});

describe('readiness decision (unit)', () => {
  const req = (id: string, phase: string) =>
    RequirementSchema.parse({ id, description: 'd', acceptance: 'a', phase, status: 'DONE', tests: ['t'], evidence: 'e' });

  it('requirement without journey coverage prevents READY', () => {
    const reqs = [req('M001-REQ-001', '01'), req('M001-REQ-002', '02')];
    const journeys = deriveJourneys([reqs[0]!]);
    const decision = decideReadiness({
      commit: 'abc', environment: 'local', deterministicChecks: [], requirements: reqs,
      journeys, journeyResults: journeys.map((j) => ({ journey_id: j.id, passed: true, steps: [], console_errors: [], network_errors: [], findings: [], screenshots: [] })),
      missingCapabilities: [], fixesApplied: [],
    });
    expect(decision.status).toBe('NOT_READY');
    expect(decision.reasons.join(' ')).toContain('M001-REQ-002');
  });

  it('failed production build prevents READY', () => {
    const reqs = [req('M001-REQ-001', '01')];
    const journeys = deriveJourneys(reqs);
    const decision = decideReadiness({
      commit: 'abc', environment: 'local',
      deterministicChecks: [{ command: 'npm run build', exit_code: 1, summary: 'boom', duration_ms: 1 }],
      requirements: reqs, journeys,
      journeyResults: journeys.map((j) => ({ journey_id: j.id, passed: true, steps: [], console_errors: [], network_errors: [], findings: [], screenshots: [] })),
      missingCapabilities: [], fixesApplied: [],
    });
    expect(decision.status).toBe('NOT_READY');
  });

  it('a project without a build script can use its available checks', () => {
    const reqs = [req('M001-REQ-001', '01')];
    const journeys = deriveJourneys(reqs);
    const decision = decideReadiness({
      commit: 'abc',
      environment: 'local',
      deterministicChecks: [{ command: 'npm test', exit_code: 0, summary: 'ok', duration_ms: 1 }],
      requirements: reqs,
      journeys,
      journeyResults: journeys.map((journey) => ({
        journey_id: journey.id,
        passed: true,
        steps: [],
        console_errors: [],
        network_errors: [],
        findings: [],
        screenshots: [],
      })),
      missingCapabilities: [],
      fixesApplied: [],
      hasBuild: false,
    });
    expect(decision.status).toBe('READY');
  });
});
