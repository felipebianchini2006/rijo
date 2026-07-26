import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { mapWorkflow } from '../src/workflows/map.js';
import { reconcileTransactions } from '../src/core/txn.js';
import { snapshotTree, diffTrees } from '../src/core/workspace.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { validateStateIntegrity } from '../src/core/traceability.js';
import { readRequirements } from '../src/core/roadmap.js';
import { tmpProject, cleanup, writePlanFile, deps, EXTRACTION_PAYLOAD } from './helpers.js';

const M2_EXTRACTION = {
  ...EXTRACTION_PAYLOAD,
  project_name: 'Loja v2',
  requirements: [{ description: 'Cupons de desconto', acceptance: 'Cupom aplica desconto', non_functional: false, classification: 'NEW' as const }],
  phases: [{ name: 'Cupons', requirement_indexes: [0], depends_on_indexes: [], ui_surface: false }],
  research_topics: [],
};

/** Copy the golden fixture into a fresh root for one injection scenario. */
function cloneFixture(golden: string): string {
  const root = tmpProject('rijo-txn-');
  fs.cpSync(golden, root, { recursive: true });
  return root;
}

function crashAt(step: string) {
  return {
    afterWrite: (s: string) => {
      if (s === step) throw new Error(`INJECTED-CRASH after ${step}`);
    },
  };
}

describe('milestone transaction crash safety (fault injection after every durable write)', () => {
  let golden: string;
  let steps: string[] = [];

  beforeAll(async () => {
    // golden fixture: M001 fully executed and sealed-ready
    golden = tmpProject('rijo-txn-golden-');
    writePlanFile(golden);
    writePlanFile(golden, 'PLANO2.md', '# Plano M002\n\nCupons.\n');
    const d = deps(golden);
    await newWorkflow(golden, { planFile: '@PLANO.md' }, d);
    const run = await runWorkflow(golden, { target: 'all' }, d);
    expect(run.ok, run.message).toBe(true);
    const mapped = await mapWorkflow(golden, {}, d);
    expect(mapped.ok, mapped.message).toBe(true);

    // discover every injection point by recording a successful --next on a clone
    const probe = cloneFixture(golden);
    const recorded: string[] = [];
    const dp = deps(probe, { extraction: M2_EXTRACTION });
    const outcome = await newWorkflow(probe, { planFile: '@PLANO2.md', next: true }, { ...dp, txnHooks: { afterWrite: (s) => recorded.push(s) } });
    expect(outcome.ok, outcome.message).toBe(true);
    steps = recorded;
    expect(steps.length).toBeGreaterThan(10);
    expect(steps).toContain('commit');
    cleanup(probe);
  }, 120_000);

  afterAll(() => cleanup(golden));

  it('crashing at EVERY injection point leaves no observable intermediate state', async () => {
    for (const step of steps) {
      const root = cloneFixture(golden);
      try {
        const paths = new RijoPaths(root);
        const before = snapshotTree(root);
        const dp = deps(root, { extraction: M2_EXTRACTION });
        await expect(
          newWorkflow(root, { planFile: '@PLANO2.md', next: true }, { ...dp, txnHooks: crashAt(step) }),
        ).rejects.toThrow(/INJECTED-CRASH/);

        const preCommit = steps.indexOf(step) < steps.indexOf('commit');
        if (preCommit) {
          // before the commit point NOTHING observable changed
          const delta = diffTrees(before, snapshotTree(root));
          expect(delta.changed, `step ${step} leaked: ${delta.changed.join(', ')}`).toEqual([]);
        }

        // startup reconciliation: rollback (pre-commit) or roll-forward (post-commit)
        reconcileTransactions(paths);
        const manifest = readManifest(paths)!;
        if (preCommit) {
          expect(manifest.active_milestone, `step ${step}`).toBe('M001');
          expect(manifest.milestones.some((m) => m.id === 'M002')).toBe(false);
          const m1dir = paths.milestoneDir('M001', manifest.milestones[0]!.slug);
          expect(fs.existsSync(path.join(m1dir, 'CLOSEOUT.md'))).toBe(false);
          // the transition is fully retryable afterwards
          const retry = await newWorkflow(root, { planFile: '@PLANO2.md', next: true }, deps(root, { extraction: M2_EXTRACTION }));
          expect(retry.ok, `retry after ${step}: ${retry.message}`).toBe(true);
        } else {
          // at/after the commit point the transition COMPLETES deterministically
          expect(manifest.active_milestone, `step ${step}`).toBe('M002');
          const m1 = manifest.milestones.find((m) => m.id === 'M001')!;
          expect(['COMPLETE', 'PARTIAL']).toContain(m1.status);
          const m1dir = paths.milestoneDir('M001', m1.slug);
          expect(fs.existsSync(path.join(m1dir, 'CLOSEOUT.md'))).toBe(true);
          const m2 = manifest.milestones.find((m) => m.id === 'M002')!;
          const m2dir = paths.milestoneDir('M002', m2.slug);
          expect(fs.existsSync(path.join(m2dir, 'REQUIREMENTS.md'))).toBe(true);
          expect(readRequirements(path.join(m2dir, 'REQUIREMENTS.md')).requirements.length).toBeGreaterThan(0);
        }
        // NEVER any drift or dangling state after reconciliation
        const issues = validateStateIntegrity(paths).filter((i) => i.severity === 'error');
        expect(issues, `step ${step}: ${issues.map((i) => i.code).join(',')}`).toEqual([]);
        // no leftover transaction dirs
        const txRoot = path.join(root, '.rijo', 'runtime', 'transactions');
        expect(!fs.existsSync(txRoot) || fs.readdirSync(txRoot).length === 0).toBe(true);
      } finally {
        cleanup(root);
      }
    }
  }, 300_000);

  it('a carryover keeps lineage but never claims the predecessor was resolved by the transition itself', async () => {
    const root = cloneFixture(golden);
    try {
      const paths = new RijoPaths(root);
      // make M001 incomplete: reset one requirement so it must be carried
      const manifest = readManifest(paths)!;
      const m1dir = paths.milestoneDir('M001', manifest.milestones[0]!.slug);
      const reqDoc = readRequirements(path.join(m1dir, 'REQUIREMENTS.md'));
      reqDoc.requirements[0]!.status = 'PENDING';
      const { writeRequirements } = await import('../src/core/roadmap.js');
      writeRequirements(path.join(m1dir, 'REQUIREMENTS.md'), reqDoc);
      const { touchManifest } = await import('../src/core/manifest.js');
      touchManifest(paths);

      const outcome = await newWorkflow(root, { planFile: '@PLANO2.md', next: true }, deps(root, { extraction: M2_EXTRACTION }));
      expect(outcome.ok, outcome.message).toBe(true);
      const m1After = readRequirements(path.join(m1dir, 'REQUIREMENTS.md'));
      // the sealed side says CARRIED — not DONE
      expect(m1After.requirements[0]!.status).toBe('CARRIED');
      const manifest2 = readManifest(paths)!;
      const m2dir = paths.milestoneDir('M002', manifest2.milestones[1]!.slug);
      const m2Reqs = readRequirements(path.join(m2dir, 'REQUIREMENTS.md'));
      const carried = m2Reqs.requirements.find((r) => r.classification === 'CARRYOVER')!;
      expect(carried.carried_from).toBe(m1After.requirements[0]!.id);
      expect(carried.resolves).toBe(m1After.requirements[0]!.id);
      // the successor starts PENDING: lineage exists, resolution is NOT claimed
      expect(carried.status).toBe('PENDING');
    } finally {
      cleanup(root);
    }
  }, 60_000);
});
