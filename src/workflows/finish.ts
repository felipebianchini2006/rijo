import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter } from '../core/frontmatter.js';
import { exists, readText, writeFileAtomic } from '../core/fsx.js';
import { touchManifest } from '../core/manifest.js';
import { activeMilestone, sealMilestone } from '../core/milestones.js';
import { readRoadmap, readRequirements } from '../core/roadmap.js';
import { TaskRecordSchema } from '../core/schemas/index.js';
import { readState, writeState } from '../core/state.js';
import {
  blockedReadOnly,
  completed,
  createContext,
  failed,
  withLock,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';
import { syncActiveProjectProjections, syncQaProjections } from './projections.js';

const TERMINAL_QA_RESULTS = new Set(['READY', 'NOT_READY', 'BLOCKED']);
const TERMINAL_TASK_STATES = new Set(['SUCCEEDED', 'FAILED', 'EXHAUSTED', 'CANCELLED']);

/** Seal a completed milestone after full product QA has a terminal result. */
export async function finishWorkflow(
  projectRoot: string,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  if (!exists(ctx.paths.manifest)) {
    return failed(ctx, 'No RIJO project here. Run `$rijo new @PLAN.md` first.');
  }

  return withLock(ctx, async () => {
    const milestone = activeMilestone(ctx.paths);
    if (!milestone) return failed(ctx, 'No active milestone.');
    if (exists(milestone.paths.closeout)) {
      const existingStatus = ctx.git.status(projectRoot);
      if (existingStatus.isRepo && ctx.config.git.commit && existingStatus.dirtyFiles.length > 0) {
        const recoverable = existingStatus.dirtyFiles.filter((file) => file.startsWith('.rijo/'));
        if (recoverable.length !== existingStatus.dirtyFiles.length) {
          return blockedReadOnly(ctx, 'The partial milestone seal has unrelated working tree changes.', [
            `Dirty files: ${existingStatus.dirtyFiles.join(', ')}`,
          ]);
        }
        const repaired = ctx.git.commitPaths(
          projectRoot,
          `rijo(${milestone.id}): recover milestone seal`,
          recoverable,
        );
        if (!repaired) {
          return blockedReadOnly(ctx, 'The partial milestone seal commit still cannot complete.');
        }
      }
      return completed(ctx, `Milestone ${milestone.id} is already sealed.`);
    }

    const roadmap = readRoadmap(milestone.paths.roadmap);
    const incompletePhases = roadmap.phases.filter((phase) => phase.status !== 'DONE');
    if (incompletePhases.length > 0) {
      return blockedReadOnly(
        ctx,
        `Milestone ${milestone.id} is incomplete.`,
        incompletePhases.map((phase) => `${phase.id}: ${phase.status}`),
      );
    }

    const requirements = readRequirements(milestone.paths.requirements);
    const missingEvidence = requirements.requirements.filter(
      (requirement) => !requirement.evidence,
    );
    if (missingEvidence.length > 0) {
      return blockedReadOnly(ctx, `Milestone ${milestone.id} lacks requirement evidence.`, [
        ...missingEvidence.map((requirement) => `${requirement.id}: missing evidence`),
      ]);
    }

    if (!exists(milestone.paths.readiness)) {
      return blockedReadOnly(ctx, 'Full product QA is required before finish.', [
        'Run `$rijo test`, then run `$rijo finish` again.',
      ]);
    }
    const readiness = parseFrontmatter<Record<string, unknown>>(
      readText(milestone.paths.readiness),
    ).data;
    const qaResult = String(readiness['status'] ?? '');
    if (!TERMINAL_QA_RESULTS.has(qaResult)) {
      return blockedReadOnly(ctx, 'Full product QA does not have a terminal result.', [
        'Run `$rijo test`, then run `$rijo finish` again.',
      ]);
    }

    const activeTasks = readActiveTaskIds(ctx.paths.runtimeDir);
    if (activeTasks.length > 0) {
      return blockedReadOnly(ctx, 'Supervised tasks are still active.', activeTasks);
    }

    const gitStatus = ctx.git.status(projectRoot);
    const userDirty = gitStatus.dirtyFiles.filter((file) => file !== '.rijo/events.jsonl');
    if (gitStatus.isRepo && userDirty.length > 0) {
      return blockedReadOnly(ctx, 'The working tree must be clean before finish.', [
        `Dirty files: ${userDirty.slice(0, 20).join(', ')}`,
      ]);
    }

    const testedCommit = String(readiness['tested_commit'] ?? readiness['commit'] ?? '') || null;
    if (gitStatus.isRepo && !testedCommit) {
      return blockedReadOnly(ctx, 'Product QA did not record the tested commit.');
    }
    const headCommit = ctx.git.headCommit(projectRoot);
    if (gitStatus.isRepo && testedCommit && headCommit && testedCommit !== headCommit) {
      const afterTest = ctx.git.diffNames(projectRoot, testedCommit, headCommit);
      const unsafe = afterTest.filter(
        (file) =>
          !file.startsWith('.rijo/qa/') &&
          !file.includes('/qa/') &&
          file !== '.rijo/events.jsonl' &&
          !file.startsWith('.rijo/ledger/'),
      );
      if (unsafe.length > 0) {
        return blockedReadOnly(ctx, 'The tested commit is not the current product commit.', [
          `Untested paths: ${unsafe.join(', ')}`,
        ]);
      }
    }
    const unresolved = requirements.requirements.filter(
      (requirement) => requirement.status !== 'DONE' && requirement.status !== 'CANCELLED',
    );
    writeFileAtomic(
      path.join(milestone.dir, 'ARCHIVE.md'),
      [
        `# Phase artifact archive — ${milestone.id}`,
        '',
        ...roadmap.phases.map(
          (phase) => `- \`phases/${phase.id}-${phase.slug}/\`: research, plan, summary, review, and verification.`,
        ),
        '',
      ].join('\n'),
    );
    sealMilestone(
      ctx.paths,
      milestone,
      {
        status: 'COMPLETE',
        baselineCommit: testedCommit,
        baselineBranch: gitStatus.branch,
        deliveredVersion: null,
        carryover: unresolved.map((requirement) => ({
          requirement,
          disposition: requirement.status === 'BLOCKED' ? 'blocked' as const : 'carried' as const,
        })),
        evidence: [path.relative(projectRoot, milestone.paths.readiness)],
        residualRisks: qaResult === 'READY' ? [] : [`Product QA result: ${qaResult}`],
        productionState: qaResult,
      },
      ctx.now,
    );

    const previousState = readState(ctx.paths);
    if (previousState) {
      writeState(
        ctx.paths,
        {
          ...previousState,
          phase: null,
          task: null,
          stage: 'READY',
          next_step: '$rijo next @NEXT-PLAN.md',
          blocked: false,
          blocked_reason: null,
          updated_at: ctx.now().toISOString(),
        },
        `Milestone ${milestone.id} is sealed. Product QA result: ${qaResult}.`,
      );
    }
    syncActiveProjectProjections(ctx.paths);
    syncQaProjections(ctx.paths, milestone.paths);
    touchManifest(ctx.paths, () => {}, ctx.now);

    if (gitStatus.isRepo && ctx.config.git.commit) {
      const changed = ctx.git.status(projectRoot).dirtyFiles;
      if (changed.length > 0) {
        const commit = ctx.git.commitPaths(
          projectRoot,
          `rijo(${milestone.id}): milestone sealed`,
          changed,
        );
        if (!commit) {
          return blockedReadOnly(ctx, 'The milestone was sealed, but the closeout commit failed.');
        }
      }
    }

    ctx.bus.emit('finish.ready', {
      status: 'completed',
      stage: 'READY',
      milestone: { id: milestone.id, name: milestone.slug },
      message: `[RIJO ${milestone.id}] READY`,
    });
    return completed(ctx, `Milestone ${milestone.id} sealed with QA result ${qaResult}.`);
  });
}

function readActiveTaskIds(runtimeDir: string): string[] {
  const tasksDir = path.join(runtimeDir, 'tasks');
  if (!exists(tasksDir)) return [];
  const active: string[] = [];
  for (const file of fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json'))) {
    try {
      const parsed = TaskRecordSchema.safeParse(
        JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf8')),
      );
      if (parsed.success && !TERMINAL_TASK_STATES.has(parsed.data.state)) {
        active.push(parsed.data.logical_task_id);
      }
    } catch {
      active.push(file);
    }
  }
  return active;
}
