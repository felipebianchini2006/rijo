import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { fixWorkflow } from '../src/workflows/fix.js';
import { RijoPaths } from '../src/core/paths.js';
import { tmpProject, cleanup, writePlanFile, deps, ok } from './helpers.js';

describe('rijo fix', () => {
  let root: string;
  beforeEach(async () => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  function wireHappyFix(d: ReturnType<typeof deps>) {
    d.runner.on(
      (t) => t.id.startsWith('fix-diagnose'),
      (t) =>
        ok(t, {
          payload: {
            reproduced: true,
            reproduction_steps: 'abrir /checkout com carrinho vazio',
            hypothesis: 'validação ausente',
            root_cause: 'checkout não valida carrinho vazio',
            escalate: false,
            escalate_reason: '',
          },
        }),
    );
    d.runner.on(
      (t) => t.id.startsWith('fix-repair'),
      (t) =>
        ok(t, {
          payload: {
            fixed: true,
            root_cause: 'checkout não valida carrinho vazio',
            change_summary: 'guarda de carrinho vazio no handler',
            regression_test: 'tests/checkout-empty.test.ts',
            regression_test_impossible_reason: null,
            verification_commands: ['echo run-regression'],
            residual_risk: 'nenhum identificado',
          },
        }),
    );
  }

  it('reproduces, fixes, adds regression and records context without creating a phase', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireHappyFix(d);
    const phaseCountBefore = countPhaseDirs(root);
    const outcome = await fixWorkflow(root, { description: 'checkout quebra com carrinho vazio' }, d);
    expect(outcome.ok, outcome.message).toBe(true);

    const fixes = fs.readdirSync(new RijoPaths(root).fixesDir);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatch(/^\d{8}-\d{4}-checkout-quebra/);
    const record = fs.readFileSync(path.join(new RijoPaths(root).fixesDir, fixes[0]!), 'utf8');
    expect(record).toContain('status: DONE');
    expect(record).toContain('Root cause');
    expect(record).toContain('tests/checkout-empty.test.ts');
    expect(record).toContain('`echo run-regression` exit 0');
    // atomic commit created
    expect(d.git.commits.some((c) => c.message.startsWith('rijo(fix):'))).toBe(true);
    // did NOT create a phase (no hidden rijo run)
    expect(countPhaseDirs(root)).toBe(phaseCountBefore);
  });

  it('escalates when the problem cannot be reproduced after 2 attempts', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    d.runner.on(
      (t) => t.id.startsWith('fix-diagnose'),
      (t) => ok(t, { payload: { reproduced: false, reproduction_steps: 'tentado', hypothesis: '', root_cause: null, escalate: false, escalate_reason: '' } }),
    );
    const outcome = await fixWorkflow(root, { description: 'bug intermitente' }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('not reproduced after 2 attempts');
    const diagnoses = d.runner.executed.filter((t) => t.id.startsWith('fix-diagnose'));
    expect(diagnoses).toHaveLength(2);
    const record = fs.readFileSync(path.join(new RijoPaths(root).fixesDir, fs.readdirSync(new RijoPaths(root).fixesDir)[0]!), 'utf8');
    expect(record).toContain('ESCALATED');
  });

  it('escalates on architectural scope instead of fixing', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    d.runner.on(
      (t) => t.id.startsWith('fix-diagnose'),
      (t) => ok(t, { payload: { reproduced: true, reproduction_steps: 'x', hypothesis: 'y', root_cause: 'z', escalate: true, escalate_reason: 'requires schema migration' } }),
    );
    const outcome = await fixWorkflow(root, { description: 'dados corrompidos' }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('requires schema migration');
    // no repair attempted
    expect(d.runner.executed.filter((t) => t.id.startsWith('fix-repair'))).toHaveLength(0);
  });

  it('bounded repair: escalates after fix_attempts failed verifications', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    d.runner.on(
      (t) => t.id.startsWith('fix-diagnose'),
      (t) => ok(t, { payload: { reproduced: true, reproduction_steps: 'x', hypothesis: 'y', root_cause: 'z', escalate: false, escalate_reason: '' } }),
    );
    d.runner.on(
      (t) => t.id.startsWith('fix-repair'),
      (t) => ok(t, { payload: { fixed: false, root_cause: '', change_summary: '', regression_test: null, regression_test_impossible_reason: 'n/a', verification_commands: [], residual_risk: '' } }),
    );
    const outcome = await fixWorkflow(root, { description: 'bug teimoso' }, d);
    expect(outcome.status).toBe('blocked');
    expect(d.runner.executed.filter((t) => t.id.startsWith('fix-repair'))).toHaveLength(2);
  });
});

function countPhaseDirs(root: string): number {
  const paths = new RijoPaths(root);
  const milestones = fs.readdirSync(paths.milestonesDir);
  let count = 0;
  for (const m of milestones) {
    const phasesDir = path.join(paths.milestonesDir, m, 'phases');
    if (fs.existsSync(phasesDir)) count += fs.readdirSync(phasesDir).length;
  }
  return count;
}
