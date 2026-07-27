import * as fs from 'node:fs';
import * as path from 'node:path';
import { exists, readText } from '../core/fsx.js';
import { parseFrontmatter } from '../core/frontmatter.js';
import { activeMilestone } from '../core/milestones.js';
import { RijoPaths } from '../core/paths.js';
import { readStatus } from '../core/progress.js';
import { readRoadmap } from '../core/roadmap.js';
import { testWorkflow } from './check.js';
import { finishWorkflow } from './finish.js';
import { fixWorkflow, type FixOptions } from './fix.js';
import { startWorkflow } from './run.js';
import {
  createContext,
  withLock,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';

export type ResumeSelection =
  | { route: 'start' }
  | { route: 'test' }
  | { route: 'fix'; options: FixOptions }
  | { route: 'finish' }
  | { route: 'complete' };

const QA_STAGES = new Set(['PRODUCT_TEST', 'CHECKS', 'JOURNEYS', 'REPORT']);
const QA_RESULTS = new Set(['READY', 'NOT_READY', 'BLOCKED']);

/** Select the interrupted native workflow without model judgment. */
export function selectResumeRoute(projectRoot: string): ResumeSelection {
  const paths = new RijoPaths(projectRoot);
  const pendingFix = readPendingFix(paths.fixesDir);
  if (pendingFix) return { route: 'fix', options: pendingFix };

  const status = readStatus(paths);
  if (status?.stage && QA_STAGES.has(status.stage)) return { route: 'test' };

  const milestone = activeMilestone(paths);
  if (!milestone) return { route: 'start' };
  if (exists(milestone.paths.closeout)) return { route: 'complete' };

  const roadmap = readRoadmap(milestone.paths.roadmap);
  if (roadmap.phases.some((phase) => phase.status !== 'DONE')) return { route: 'start' };

  if (!exists(milestone.paths.readiness)) return { route: 'test' };
  const readiness = parseFrontmatter<Record<string, unknown>>(
    readText(milestone.paths.readiness),
  ).data;
  return QA_RESULTS.has(String(readiness['status'] ?? ''))
    ? { route: 'finish' }
    : { route: 'test' };
}

/** Resume implementation, QA, fix, or finish from deterministic state. */
export async function resumeWorkflow(
  projectRoot: string,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const selection = selectResumeRoute(projectRoot);
  switch (selection.route) {
    case 'start':
      return startWorkflow(projectRoot, deps);
    case 'test':
      return testWorkflow(projectRoot, {}, deps);
    case 'fix':
      return fixWorkflow(projectRoot, selection.options, deps);
    case 'finish':
      return finishWorkflow(projectRoot, deps);
    case 'complete':
      return {
        ok: true,
        status: 'completed',
        message: 'The active milestone is already sealed.',
      };
  }
}

/** Reconcile durable state without entering an agent workflow. */
export async function recoverNativeState(
  projectRoot: string,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  return withLock(
    ctx,
    async () => ({
      ok: true,
      status: 'completed',
      message: 'Native workflow state recovered.',
    }),
    { terminal: false },
  );
}

function readPendingFix(fixesDir: string): FixOptions | null {
  if (!exists(fixesDir)) return null;
  const files = fs
    .readdirSync(fixesDir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .reverse();
  for (const file of files) {
    try {
      const data = parseFrontmatter<Record<string, unknown>>(
        readText(path.join(fixesDir, file)),
      ).data;
      if (data['status'] !== 'IN_PROGRESS' || typeof data['description'] !== 'string') continue;
      return {
        description: data['description'],
        evidenceFiles: Array.isArray(data['evidence_files'])
          ? data['evidence_files'].filter(
              (item): item is string => typeof item === 'string',
            )
          : [],
      };
    } catch {
      continue;
    }
  }
  return null;
}
