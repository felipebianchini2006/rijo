import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { checkWorkflow } from '../src/workflows/check.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { decideReadiness } from '../src/qa/readiness.js';
import { deriveJourneys } from '../src/qa/journeys.js';
import { RequirementSchema } from '../src/core/schemas/index.js';
import { tmpProject, cleanup, writePlanFile, deps, ok } from './helpers.js';

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
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.status).toBe('blocked');
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('status: BLOCKED');
    expect(report).toContain('browser');
  });

  it('all valid gates produce READY with pinned commit and evidence', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    d.git.commitAll(root, 'baseline');
    wireJourneys(d, () => ({}));
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('status: READY');
    expect(report).toContain(d.git.headCommit()!);
    expect(report).toContain('## Journeys');
  });

  it('a console error in a critical flow prevents READY', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireJourneys(d, (id) => (id === 'J01' ? { console_errors: ['TypeError: cannot read products'] } : {}));
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok).toBe(false);
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('status: NOT_READY');
    expect(report).toContain('console errors');
  });

  it('a 5xx network error prevents READY', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireJourneys(d, (id) => (id === 'J02' ? { network_errors: ['POST /api/checkout → 500'] } : {}));
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok).toBe(false);
    expect(fs.readFileSync(readinessPath(root), 'utf8')).toContain('Network errors');
  });

  it('a relevant visual finding appears in the report', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireJourneys(d, () => ({}));
    d.runner.on(
      (t) => t.id === 'check-visual',
      (t) => ok(t, { payload: { findings: [{ severity: 'high', description: 'botão de checkout desalinhado no mobile', evidence: null }] } }),
    );
    const outcome = await checkWorkflow(root, {}, d);
    expect(outcome.ok).toBe(false);
    const report = fs.readFileSync(readinessPath(root), 'utf8');
    expect(report).toContain('desalinhado');
    expect(report).toContain('[high]');
  });

  it('--fix groups failures and re-runs only failing journeys, bounded at 2 rounds', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    let fixed = false;
    d.runner.on(
      (t) => t.id.startsWith('journey-'),
      (t) => {
        const id = t.id.replace('journey-', '');
        const failing = id === 'J01' && !fixed;
        return ok(t, {
          payload: {
            journey_id: id, passed: !failing, steps: [], console_errors: [], network_errors: [],
            findings: failing ? [{ severity: 'high', description: 'busca não retorna resultados', evidence: null }] : [],
            screenshots: [],
          },
        });
      },
    );
    d.runner.on(
      (t) => t.id.startsWith('check-fix-'),
      (t) => {
        fixed = true;
        return ok(t, { payload: { done: true, notes: 'causa raiz corrigida' } });
      },
    );
    const outcome = await checkWorkflow(root, { fix: true }, d);
    expect(outcome.ok, outcome.message).toBe(true);
    expect(d.runner.executed.filter((t) => t.id.startsWith('check-fix-'))).toHaveLength(1);
    // J01 re-ran; J02 did not (2 initial + 1 rerun = 3 journey executions)
    expect(d.runner.executed.filter((t) => t.id.startsWith('journey-'))).toHaveLength(3);
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
});
