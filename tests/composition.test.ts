import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { uiWorkflow } from '../src/workflows/ui.js';
import { startWorkflow } from '../src/workflows/run.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest, touchManifest } from '../src/core/manifest.js';
import { readRoadmap } from '../src/core/roadmap.js';
import { sha256File } from '../src/core/fsx.js';
import { createWorkflowEpoch } from '../src/core/workflow-epoch.js';
import { validateStateIntegrity } from '../src/core/traceability.js';
import { TaskStore } from '../src/supervisor/store.js';
import {
  tmpProject,
  cleanup,
  writePlanFile,
  deps,
  ok,
  uiSmokeOk,
  wireUi,
  uiOperation,
} from './helpers.js';

function milestoneDir(root: string): string {
  const paths = new RijoPaths(root);
  const m = readManifest(paths)!;
  const entry = m.milestones.find((x) => x.id === m.active_milestone)!;
  return paths.milestoneDir(entry.id, entry.slug);
}

describe('new → ui → start composition', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html><body>Home</body></html>'));
    zip.writeZip(path.join(root, 'design.zip'));
  });
  afterEach(() => cleanup(root));

  it('runs each public workflow in order without a lock deadlock', async () => {
    const d = deps(root, { capabilities: { subagents: true, parallelism: true, browser: true } });
    wireUi(d, root);
    // browser:true also activates run.ts's per-phase UI_SMOKE gate for
    // ui_surface phases (independent of the ui import pipeline itself).
    d.runner.on(
      (t) => t.id.startsWith('ui-smoke-'),
      (t) => uiSmokeOk(t, 'The UI smoke passed.'),
    );

    const created = await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    expect(created.ok, created.message).toBe(true);
    const ui = uiOperation(root, d);
    const imported = await uiWorkflow(root, { input: '@design.zip' }, ui.deps);
    expect(imported.ok, imported.message).toBe(true);
    const outcome = await startWorkflow(root, d);
    expect(outcome.ok, outcome.message + ' :: ' + (outcome.details ?? []).join(' | ')).toBe(true);

    // ui import happened
    expect(fs.existsSync(path.join(ui.importDir, 'MAPPING.md'))).toBe(true);
    const uiEpochs = new Set(
      d.runner.executed
        .filter((task) => /^ui-(?:map|convert|validate)-/.test(task.id))
        .map((task) => task.attempt?.workflow_epoch),
    );
    expect(uiEpochs).toEqual(new Set([ui.workflowEpoch]));
    expect(
      d.runner.executed
        .filter((task) => !/^ui-(?:map|convert|validate)-/.test(task.id))
        .some((task) => task.attempt?.workflow_epoch === ui.workflowEpoch),
    ).toBe(false);
    // and all phases ran to DONE
    const roadmap = readRoadmap(path.join(milestoneDir(root), 'ROADMAP.md'));
    expect(roadmap.phases.every((p) => p.status === 'DONE')).toBe(true);
    expect(
      fs.existsSync(path.join(milestoneDir(root), 'phases', '01-catalog', 'REVIEW.md')),
    ).toBe(true);
    // the lock file is released at the end
    expect(fs.existsSync(new RijoPaths(root).lock)).toBe(false);

    const smokeReceipt = path.join(
      milestoneDir(root),
      'phases',
      '01-catalog',
      'UI-SMOKE.json',
    );
    fs.appendFileSync(smokeReceipt, ' ');
    expect(
      validateStateIntegrity(new RijoPaths(root)).some((issue) =>
        issue.message.includes('UI-SMOKE.json'),
      ),
    ).toBe(true);
  });

  it('reuses an accepted engineering review after a UI smoke pause', async () => {
    const d = deps(root, {
      capabilities: { subagents: true, parallelism: true, browser: true },
    });
    d.runner.on(
      (task) => task.id.startsWith('ui-smoke-'),
      (task) =>
        ok(task, {
          payload: {
            passed: false,
            console_errors: ['The smoke gate paused before completion.'],
            network_errors: [],
            screenshot: null,
            notes: 'Pause the workflow after the accepted review.',
          },
        }),
    );

    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const startDeps = { ...d, workflowEpoch: createWorkflowEpoch() };

    const first = await startWorkflow(root, startDeps);
    expect(first.status).toBe('blocked');

    const second = await startWorkflow(root, startDeps);
    expect(second.status).toBe('blocked');

    const reviews = d.runner.executed.filter((task) => task.id === 'code-review-01-l0');
    expect(reviews).toHaveLength(1);
    expect(new TaskStore(new RijoPaths(root)).read('code-review-01-l0')?.generation).toBe(1);

    const reviewPath = path.join(
      milestoneDir(root),
      'phases',
      '01-catalog',
      'REVIEW.md',
    );
    expect(fs.readFileSync(reviewPath, 'utf8')).toContain('gate_status: ACCEPTED');
  });

  it('invalidates an accepted review when the complete source delta changes', async () => {
    const d = deps(root, {
      capabilities: { subagents: true, parallelism: true, browser: true },
    });
    d.runner.on(
      (task) => task.id.startsWith('ui-smoke-'),
      (task) =>
        ok(task, {
          payload: {
            passed: false,
            console_errors: ['Keep the phase open for the invalidation test.'],
            network_errors: [],
            screenshot: null,
            notes: 'The smoke gate remains open.',
          },
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const startDeps = { ...d, workflowEpoch: createWorkflowEpoch() };

    expect((await startWorkflow(root, startDeps)).status).toBe('blocked');
    fs.appendFileSync(path.join(root, 'src', 'a.ts'), '\nexport const changedAfterReview = true;\n');
    const baselinePath = path.join(
      new RijoPaths(root).runtimeDir,
      'phase-baselines',
      'M001-01.json',
    );
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
      controlled_snapshot: Array<[string, string]>;
    };
    baseline.controlled_snapshot = baseline.controlled_snapshot
      .filter(([file]) => file !== 'src/a.ts')
      .concat([['src/a.ts', sha256File(path.join(root, 'src', 'a.ts'))]])
      .sort(([left], [right]) => left.localeCompare(right));
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    expect((await startWorkflow(root, startDeps)).status).toBe('blocked');

    expect(
      d.runner.executed.filter((task) => task.id.startsWith('code-review-01-')),
    ).toHaveLength(2);
  });

  it('rejects a successful UI smoke screenshot traversal outside its authorized scope', async () => {
    const d = deps(root, {
      capabilities: { subagents: true, parallelism: true, browser: true },
    });
    d.runner.on(
      (task) => task.id.startsWith('ui-smoke-'),
      (task) => {
        const screenshotDirectory = task.write_scope[0]!.slice(0, -3);
        return ok(task, {
          payload: {
            passed: true,
            console_errors: [],
            network_errors: [],
            screenshot: `${screenshotDirectory}/../../../../package.json`,
            notes: 'The path contains an intentional traversal.',
          },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await startWorkflow(root, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.details?.join('\n')).toMatch(/normalized and project-relative/i);
  });

  it('rejects a UI smoke screenshot that is a symlink to a project source file', async () => {
    const d = deps(root, {
      capabilities: { subagents: true, parallelism: true, browser: true },
    });
    d.runner.on(
      (task) => task.id.startsWith('ui-smoke-'),
      (task) => {
        if (!task.workspace) throw new Error('The smoke task has no workspace.');
        const screenshotDirectory = task.write_scope[0]!.slice(0, -3);
        const screenshot = `${screenshotDirectory}/source-link.png`;
        const absolute = path.join(task.workspace.root, screenshot);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.symlinkSync(
          path.relative(path.dirname(absolute), path.join(task.workspace.root, 'src', 'a.ts')),
          absolute,
        );
        return ok(task, {
          files_written: [screenshot],
          payload: {
            passed: true,
            console_errors: [],
            network_errors: [],
            screenshot,
            notes: 'The path is intentionally a symbolic link.',
          },
        });
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await startWorkflow(root, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.details?.join('\n')).toMatch(/regular file/i);
  });

  it('resumes after a crash following successful UI smoke without rerunning native gates', async () => {
    const d = deps(root, {
      capabilities: { subagents: true, parallelism: true, browser: true },
    });
    d.runner.on(
      (task) => task.id.startsWith('ui-smoke-'),
      (task) => {
        const result = uiSmokeOk(task, 'The smoke gate passed.');
        return {
          ...result,
          decision_proposals: [
            {
              id: 'DEC-smoke-recovery',
              context: 'Keep the smoke journey on the primary UI route.',
              selected_option: 'Use the primary UI route.',
              rationale: 'The phase acceptance uses the primary route.',
              material: true,
              impact: 'low',
              confidence: 0.9,
              reversible: true,
              consequences: ['The smoke remains bounded to the main route.'],
              review_condition: 'Review when the phase adds another critical route.',
              evidence: [
                {
                  path: 'src/a.ts',
                  file_hash: sha256File(path.join(root, 'src/a.ts')),
                },
              ],
              blocker: null,
            },
          ],
        };
      },
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const workflowEpoch = createWorkflowEpoch();
    const crashDeps = {
      ...d,
      workflowEpoch,
      phaseGateHooks: {
        afterUiSmokeReceipt() {
          throw new Error('INJECTED-CRASH after UI smoke receipt');
        },
      },
    };

    await expect(startWorkflow(root, crashDeps)).rejects.toThrow(
      'INJECTED-CRASH after UI smoke receipt',
    );

    const resume = deps(root, {
      capabilities: { subagents: true, parallelism: true, browser: true },
    });
    resume.runner.on(
      (task) => task.id.startsWith('ui-smoke-'),
      (task) => uiSmokeOk(task, 'This handler must not run for phase 01.'),
    );
    const outcome = await startWorkflow(root, { ...resume, workflowEpoch });

    expect(outcome.ok, outcome.message).toBe(true);
    expect(
      resume.runner.executed.filter((task) => task.id === 'code-review-01-l0'),
    ).toHaveLength(0);
    expect(
      resume.runner.executed.filter((task) => task.id === 'ui-smoke-01'),
    ).toHaveLength(0);
    expect(
      fs.existsSync(path.join(milestoneDir(root), 'phases', '01-catalog', 'REVIEW.md')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(milestoneDir(root), 'phases', '01-catalog', 'UI-SMOKE.json')),
    ).toBe(true);
    expect(fs.readFileSync(new RijoPaths(root).decisions, 'utf8')).toContain(
      'DEC-smoke-recovery',
    );
  });

  it('commits review decisions after a crash between the review receipt and decision journal', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'code-review-01-l0',
      (task) =>
        ok(task, {
          payload: { approved: true, findings: [] },
          decision_proposals: [
            {
              id: 'DEC-phase-review-recovery',
              context: 'Keep the phase implementation in the existing source module.',
              selected_option: 'Use the existing source module.',
              rationale: 'The implemented file is the current phase boundary.',
              material: true,
              impact: 'medium',
              confidence: 0.9,
              reversible: true,
              consequences: ['The phase keeps one source boundary.'],
              review_condition: 'Review if another consumer needs a separate module.',
              evidence: [
                {
                  path: 'src/a.ts',
                  file_hash: sha256File(path.join(root, 'src/a.ts')),
                },
              ],
              blocker: null,
            },
          ],
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const workflowEpoch = createWorkflowEpoch();

    await expect(
      startWorkflow(root, {
        ...d,
        workflowEpoch,
        phaseGateHooks: {
          afterAcceptedReview() {
            throw new Error('INJECTED-CRASH after accepted review receipt');
          },
        },
      }),
    ).rejects.toThrow('INJECTED-CRASH after accepted review receipt');

    const resume = deps(root);
    const outcome = await startWorkflow(root, { ...resume, workflowEpoch });

    expect(outcome.ok, outcome.message).toBe(true);
    expect(
      resume.runner.executed.filter((task) => task.id === 'code-review-01-l0'),
    ).toHaveLength(0);
    expect(fs.readFileSync(new RijoPaths(root).decisions, 'utf8')).toContain(
      'DEC-phase-review-recovery',
    );
  });

  it('fails closed when a durable decision receipt no longer validates', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'code-review-01-l0',
      (task) =>
        ok(task, {
          payload: { approved: true, findings: [] },
          decision_proposals: [
            {
              id: 'DEC-invalid-replay',
              context: 'Keep the active project context.',
              selected_option: 'Use the current project context.',
              rationale: 'The project context contains the current scope.',
              material: true,
              impact: 'medium',
              confidence: 0.9,
              reversible: true,
              consequences: ['The phase uses the current project context.'],
              review_condition: 'Review when the project context changes.',
              evidence: [
                {
                  path: '.rijo/PROJECT.md',
                  file_hash: sha256File(new RijoPaths(root).project),
                },
              ],
              blocker: null,
            },
          ],
        }),
    );
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const workflowEpoch = createWorkflowEpoch();

    await expect(
      startWorkflow(root, {
        ...d,
        workflowEpoch,
        phaseGateHooks: {
          afterAcceptedReview() {
            throw new Error('INJECTED-CRASH before decision materialization');
          },
        },
      }),
    ).rejects.toThrow('INJECTED-CRASH before decision materialization');

    const paths = new RijoPaths(root);
    fs.appendFileSync(paths.project, '\nThe project context changed after the receipt.\n');
    touchManifest(paths);

    const resume = deps(root);
    await expect(
      startWorkflow(root, { ...resume, workflowEpoch }),
    ).rejects.toThrow(/durable decision receipt failed revalidation/i);
    expect(fs.readFileSync(paths.decisions, 'utf8')).not.toContain('DEC-invalid-replay');
  });

  it('recovers a phase gate transaction that crashes between manifest and receipt apply', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const workflowEpoch = createWorkflowEpoch();
    let injected = false;

    await expect(
      startWorkflow(root, {
        ...d,
        workflowEpoch,
        txnHooks: {
          afterWrite(step) {
            if (!injected && step === 'apply:file:.rijo/manifest.json') {
              injected = true;
              throw new Error('INJECTED-CRASH during phase gate apply');
            }
          },
        },
      }),
    ).rejects.toThrow('INJECTED-CRASH during phase gate apply');

    const paths = new RijoPaths(root);
    expect(
      validateStateIntegrity(paths).some((issue) =>
        ['DRIFT', 'DRIFT_MISSING'].includes(issue.code),
      ),
    ).toBe(true);

    const resume = deps(root);
    const outcome = await startWorkflow(root, { ...resume, workflowEpoch });

    expect(outcome.ok, outcome.message).toBe(true);
    expect(
      resume.runner.executed.filter((task) => task.id === 'code-review-01-l0'),
    ).toHaveLength(0);
    expect(validateStateIntegrity(paths)).toEqual([]);
  });
});
