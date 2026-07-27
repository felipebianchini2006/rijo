import { exists } from '../core/fsx.js';
import { readManifest } from '../core/manifest.js';
import { activeMilestone } from '../core/milestones.js';
import { RijoPaths } from '../core/paths.js';
import { newWorkflow } from './new.js';
import type { WorkflowDeps, WorkflowOutcome } from './shared.js';

/** Start a new milestone only after `finish` sealed the current milestone. */
export async function nextWorkflow(
  projectRoot: string,
  planFile: string,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const paths = new RijoPaths(projectRoot);
  const milestone = activeMilestone(paths);
  const manifest = readManifest(paths);
  if (!milestone || !manifest) {
    return {
      ok: false,
      status: 'failed',
      message: 'No RIJO project here. Run `$rijo new @PLAN.md` first.',
    };
  }
  const entry = manifest.milestones.find((candidate) => candidate.id === milestone.id);
  if (!entry || entry.status !== 'COMPLETE' || !exists(milestone.paths.closeout)) {
    return {
      ok: false,
      status: 'blocked',
      message: `Milestone ${milestone.id} is not sealed.`,
      details: ['Run `$rijo finish`, then run `$rijo next @NEXT-PLAN.md` again.'],
    };
  }
  return newWorkflow(projectRoot, { planFile, next: true }, deps);
}
