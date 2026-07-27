import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { uiWorkflow } from '../src/workflows/ui.js';
import { fixWorkflow } from '../src/workflows/fix.js';
import { checkWorkflow } from '../src/workflows/check.js';
import { renderBrief } from '../src/agents/prompts.js';
import type { AgentTask } from '../src/agents/protocol.js';
import type { FakeAgentRunner } from '../src/agents/runner.js';
import { tmpProject, cleanup, writePlanFile, deps, newMappedReference, ok, wireUi, phaseReqIds } from './helpers.js';

/** The last executed task whose id matches a prefix (routing is stamped on it). */
function lastExecuted(runner: FakeAgentRunner, idPrefix: string): AgentTask {
  const match = [...runner.executed].reverse().find((t) => t.id.startsWith(idPrefix));
  if (!match) throw new Error(`no executed task with id prefix "${idPrefix}"`);
  return match;
}

describe('expert routing on real workflow tasks (P0.6)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('new: planner extraction gets product-manager/system-architect; researcher gets exactly discovery-analyst', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);

    const extract = lastExecuted(d.runner, 'new-extract');
    expect(extract.expert_profiles).toContain('product-manager');
    expect(extract.expert_profiles).toContain('system-architect');
    // brief carries the embedded guidance
    expect(renderBrief(extract)).toContain('## Expert guidance');

    const research = lastExecuted(d.runner, 'new-research');
    expect(research.expert_profiles).toEqual(['discovery-analyst']);
  });

  it('run: planner (PLAN), backend worker (senior-software-engineer), reviewer never repeats the author lens', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const outcome = await runWorkflow(root, {}, d);
    expect(outcome.ok, outcome.message).toBe(true);

    const planner = lastExecuted(d.runner, 'plan-01');
    expect(planner.expert_profiles).toContain('product-manager');
    expect(planner.expert_profiles).toContain('system-architect');

    // backend worker writing under src/** gets the engineering lens
    const worker = lastExecuted(d.runner, 'exec-01-T01');
    expect(worker.expert_profiles).toContain('senior-software-engineer');
    expect(renderBrief(worker)).toContain('## Expert guidance');

    // the independent code reviewer gets test-architect and NEVER the author's lens
    const reviewer = lastExecuted(d.runner, 'code-review-01');
    expect(reviewer.expert_profiles).toContain('test-architect');
    expect(reviewer.expert_profiles).not.toContain('senior-software-engineer');
  });

  it('run: a security-sensitive worker (auth path) receives the security-engineer lens', async () => {
    const d = deps(root, {
      planPayload: (phaseId) => ({
        phase: phaseId,
        tasks: [
          {
            id: 'T01', name: 'auth session guard', requirement_ids: phaseReqIds(root, phaseId),
            technical_justification: null, files: ['src/auth/session.ts'], mapped_references: [newMappedReference('src/auth/session.ts')], write_scope: ['src/auth/session.ts'],
            depends_on: [], parallel: false, tdd: false, tests: ['echo ok'], evidence_expected: 'e', done: false,
          },
          {
            id: 'T02', name: 'wire it', requirement_ids: [], technical_justification: 'integration',
            files: ['src/b.ts'], mapped_references: [newMappedReference('src/b.ts')], write_scope: ['src/b.ts'], depends_on: ['T01'],
            parallel: false, tdd: false, tests: [], evidence_expected: 'e', done: false,
          },
        ],
      }),
    });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    await runWorkflow(root, {}, d);

    const secWorker = lastExecuted(d.runner, 'exec-01-T01');
    expect(secWorker.expert_profiles).toContain('security-engineer');
  });

  it('ui: the conversion worker receives the ux-product-designer lens', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireUi(d, root);
    // a minimal single-page design directory
    const designDir = `${root}/design`;
    const fs = await import('node:fs');
    fs.mkdirSync(designDir, { recursive: true });
    fs.writeFileSync(`${designDir}/index.html`, '<html><body>home</body></html>');
    const outcome = await uiWorkflow(root, { input: '@design' }, d);
    expect(outcome.ok, outcome.message).toBe(true);

    const convert = lastExecuted(d.runner, 'ui-convert-');
    expect(convert.expert_profiles).toContain('ux-product-designer');
    expect(renderBrief(convert)).toContain('## Expert guidance');
  });

  it('fix: diagnose and repair receive the debugger lens', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    d.runner
      .on(
        (t) => t.id.startsWith('fix-diagnose'),
        (t) => ok(t, { payload: { reproduced: true, reproduction_steps: 's', hypothesis: 'h', root_cause: 'c', escalate: false, escalate_reason: '' } }),
      )
      .on(
        (t) => t.id.startsWith('fix-repair'),
        (t) => ok(t, { payload: { fixed: true, root_cause: 'c', change_summary: 'guard', regression_test: 'tests/x.test.ts', regression_test_impossible_reason: null, verification_commands: ['echo ok'], residual_risk: 'none' } }),
      );
    const outcome = await fixWorkflow(root, { description: 'bug on empty cart' }, d);
    expect(outcome.ok, outcome.message).toBe(true);

    expect(lastExecuted(d.runner, 'fix-diagnose').expert_profiles).toContain('debugger');
    expect(lastExecuted(d.runner, 'fix-repair').expert_profiles).toContain('debugger');
  });

  it('check: qa journeys receive the test-architect lens', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    d.runner.on(
      (t) => t.id.startsWith('journey-'),
      (t) => ok(t, { payload: { journey_id: t.id.replace('journey-', ''), passed: true, steps: [], console_errors: [], network_errors: [], findings: [], screenshots: [] } }),
    );
    await checkWorkflow(root, {}, d);

    const journey = lastExecuted(d.runner, 'journey-');
    expect(journey.expert_profiles).toContain('test-architect');
  });
});
