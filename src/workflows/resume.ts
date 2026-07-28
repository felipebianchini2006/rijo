import * as fs from 'node:fs';
import * as path from 'node:path';
import { exists, readText } from '../core/fsx.js';
import { parseFrontmatter } from '../core/frontmatter.js';
import { activeMilestone } from '../core/milestones.js';
import { RijoPaths } from '../core/paths.js';
import { readStatus } from '../core/progress.js';
import { readRoadmap } from '../core/roadmap.js';
import {
  workflowOperationKey,
  type WorkflowOperation,
} from '../core/workflow-epoch.js';
import { testWorkflow } from './check.js';
import { finishWorkflow } from './finish.js';
import { fixWorkflow, type FixOptions } from './fix.js';
import { mapWorkflow } from './map.js';
import { newWorkflow } from './new.js';
import { nextWorkflow } from './next.js';
import { startWorkflow } from './run.js';
import {
  createContext,
  withLock,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';
import { uiWorkflow } from './ui.js';

export type ResumeSelection =
  | { route: 'start' }
  | { route: 'test' }
  | { route: 'fix'; options: FixOptions }
  | { route: 'finish' }
  | { route: 'complete' };

export type ActiveResumeSelection =
  | { route: 'map-codebase' }
  | { route: 'new'; planFile: string }
  | { route: 'ui'; inputs: string[] }
  | { route: 'next'; planFile: string }
  | { route: 'start' }
  | { route: 'test' }
  | { route: 'fix'; options: FixOptions }
  | { route: 'finish' }
  | { route: 'blocked'; reason: string };

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

/**
 * Route an active marker to its exact public workflow. Input-bearing
 * operations fail closed when their immutable arguments are absent or changed.
 */
export function selectActiveResumeRoute(
  projectRoot: string,
  operation: WorkflowOperation,
): ActiveResumeSelection {
  const args = operation.operation_args;
  const blocked = (reason: string): ActiveResumeSelection => ({
    route: 'blocked',
    reason,
  });
  if (
    workflowOperationKey(projectRoot, operation.operation, args) !==
    operation.operation_key
  ) {
    return blocked(
      `The immutable inputs for the active ${operation.operation} workflow changed. Run the original public command again with the same inputs.`,
    );
  }
  const requireExistingInputs = (values = args): string | null => {
    for (const value of values) {
      const candidate = path.resolve(projectRoot, value.replace(/^@/, ''));
      if (!exists(candidate)) return value;
    }
    return null;
  };

  switch (operation.operation) {
    case 'map-codebase':
      return args.length === 0
        ? { route: 'map-codebase' }
        : blocked('The active map-codebase workflow has invalid immutable inputs.');
    case 'new': {
      if (args.length !== 1 || !args[0]!.startsWith('@')) {
        return blocked('The active new workflow does not contain its approved plan input.');
      }
      const missing = requireExistingInputs();
      return missing
        ? blocked(`The approved plan input is unavailable: ${missing}.`)
        : { route: 'new', planFile: args[0]! };
    }
    case 'ui': {
      if (args.length === 0 || args.some((value) => !value.startsWith('@'))) {
        return blocked('The active ui workflow does not contain its design inputs.');
      }
      const missing = requireExistingInputs();
      return missing
        ? blocked(`A design input is unavailable: ${missing}.`)
        : { route: 'ui', inputs: args };
    }
    case 'next': {
      if (args.length !== 1 || !args[0]!.startsWith('@')) {
        return blocked('The active next workflow does not contain its approved plan input.');
      }
      const missing = requireExistingInputs();
      return missing
        ? blocked(`The approved next plan input is unavailable: ${missing}.`)
        : { route: 'next', planFile: args[0]! };
    }
    case 'start':
      return args.length === 0
        ? { route: 'start' }
        : blocked('The active start workflow has invalid immutable inputs.');
    case 'test':
      return args.length === 0
        ? { route: 'test' }
        : blocked('The active test workflow has invalid immutable inputs.');
    case 'fix': {
      const description = args
        .filter((value) => !value.startsWith('@'))
        .join(' ')
        .trim();
      if (!description) {
        return blocked('The active fix workflow does not contain its issue description.');
      }
      const evidenceFiles = args
        .filter((value) => value.startsWith('@'))
        .map((value) => value.slice(1));
      const missing = requireExistingInputs(
        args.filter((value) => value.startsWith('@')),
      );
      return missing
        ? blocked(`A fix evidence input is unavailable: ${missing}.`)
        : { route: 'fix', options: { description, evidenceFiles } };
    }
    case 'finish':
      return args.length === 0
        ? { route: 'finish' }
        : blocked('The active finish workflow has invalid immutable inputs.');
    default:
      return blocked(
        `The active workflow operation is not supported by resume: ${operation.operation}.`,
      );
  }
}

/** Resume the exact active operation, or select a route from portable state. */
export async function resumeWorkflow(
  projectRoot: string,
  deps: WorkflowDeps = {},
  activeOperation?: WorkflowOperation,
): Promise<WorkflowOutcome> {
  const selection = activeOperation
    ? selectActiveResumeRoute(projectRoot, activeOperation)
    : selectResumeRoute(projectRoot);
  switch (selection.route) {
    case 'map-codebase':
      return mapWorkflow(projectRoot, {}, deps);
    case 'new':
      return newWorkflow(projectRoot, { planFile: selection.planFile }, deps);
    case 'ui':
      return uiWorkflow(projectRoot, { inputs: selection.inputs }, deps);
    case 'next':
      return nextWorkflow(projectRoot, selection.planFile, deps);
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
    case 'blocked':
      return {
        ok: false,
        status: 'blocked',
        message: selection.reason,
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
