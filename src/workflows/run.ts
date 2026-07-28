import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { exists, readJsonIfExists, readText, readTextIfExists, sha256, sha256File, writeFileAtomic, writeJsonAtomic, ensureDir } from '../core/fsx.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { phasePaths, type PhasePaths } from '../core/paths.js';
import { readState } from '../core/state.js';
import {
  canonicalBaselineHash,
  computeHashes,
  readManifest,
  touchManifest,
  type HashOverlay,
} from '../core/manifest.js';
import { activeMilestone, type MilestoneRef } from '../core/milestones.js';
import { readRequirements, readRoadmap, writeRoadmap, nextPhase, type RoadmapDoc } from '../core/roadmap.js';
import {
  readPlan,
  writePlan,
  lintPlan,
  setTaskStatus,
  parallelGroups,
  preserveEquivalentPlanProgress,
  planContractHash,
  hasValidPortablePlanApproval,
} from '../core/plan.js';
import { validateStateIntegrity } from '../core/traceability.js';
import { checkContextBudget } from '../core/contextBudget.js';
import { snapshotFiles, diffSnapshots, pathInScope, type FileSnapshot } from '../core/scope.js';
import {
  AttemptWorkspace,
  snapshotTree,
  diffTrees,
  findEscapingSymlinks,
  WorkspaceScopeError,
  CanonicalWriteError,
  SymlinkEscapeError,
  PatchConflictError,
} from '../core/workspace.js';
import { redact } from '../security/redact.js';
import { DecisionProposalSchema } from '../core/decisions.js';
import { PhasePlanDraftSchema, PhasePlanSchema, ReviewFindingTypeSchema, FindingSeveritySchema, looseBool, type RoadmapPhase, type PhasePlan, type TaskStatus } from '../core/schemas/index.js';
import type { CommandEvidence } from '../core/commands.js';
import {
  AgentTaskSchema,
  AgentResultSchema,
  type AgentTask,
  type AgentTaskDraft,
  type AgentResult,
} from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  dispatch,
  dispatchBatch,
  guardSchema,
  replaceableAttempt,
  dispatchReadOnly,
  commitDecisionProposals,
  validateAgentDecisions,
  discardDecisionProposals,
  durableCheckpoint,
  isNativeResultRequired,
  isWorkflowCancellation,
  type ReplaceableAttempt,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
  type ValidatedAgentEnvelope,
} from './shared.js';
import { checkCore } from './check.js';
import {
  inferSecurityTag,
  inferHighRisk,
  prepareDispatchedTask,
} from './routing.js';
import { stageFinalization } from './finalize.js';
import { syncActiveProjectProjections } from './projections.js';
import { supervisedTaskHash } from '../supervisor/supervisor.js';
import {
  buildContextPacket,
  gapsAffectingScope,
  structuredGapsAffectingScope,
  validatePlanMapReferences,
} from '../codebase/context.js';
import { readMapState } from '../codebase/state.js';
import { ensureCodebaseMap } from './map.js';
import { TaskStore } from '../supervisor/store.js';
import {
  completeRetainedTaskPatch,
  listPendingTaskPatches,
  MilestoneTransaction,
  TransactionApplyConflictError,
  type PendingTaskPatch,
  type TxnPathState,
} from '../core/txn.js';
import { WorkflowEpochSchema } from '../core/workflow-epoch.js';

export interface RunOptions {
  /** undefined = resume from STATE.md; 'next' = next ready phase; 'all' = every phase; 'NN' = specific phase */
  target?: string;
  /** Explicit programmatic opt-in/out for the same-lock production --fix gate. */
  finalCheck?: boolean;
}

const ReviewPayloadSchema = z.object({
  approved: looseBool(false),
  findings: z
    .array(
      z.object({
        type: ReviewFindingTypeSchema,
        severity: FindingSeveritySchema.default('medium'),
        description: z.string(),
        file: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

const RepairSpecSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  acceptance: z.array(z.string()),
  commands: z.array(z.string()),
  notes: z.string(),
});

const RepairControlledUpdateSchema = z.object({
  path: z.string().min(1),
  state: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('absent') }),
    z.object({
      kind: z.literal('file'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    z.object({ kind: z.literal('symlink'), target: z.string() }),
  ]),
});

const PhaseRepairReceiptSchema = z
  .object({
    version: z.literal(1),
    phase: z.string().regex(/^\d{2}$/),
    kind: z.enum(['verification', 'review']),
    loop: z.number().int().min(1),
    status: z.enum(['PENDING', 'APPLIED']),
    task: RepairSpecSchema,
    created_at: z.string().datetime({ offset: true }),
    applied_at: z.string().datetime({ offset: true }).optional(),
    transaction_id: z.string().min(1).optional(),
    controlled_updates: z.array(RepairControlledUpdateSchema).optional(),
  })
  .superRefine((receipt, issue) => {
    if (
      receipt.status === 'APPLIED' &&
      (!receipt.applied_at ||
        !receipt.transaction_id ||
        !receipt.controlled_updates ||
        receipt.controlled_updates.length === 0)
    ) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'An applied repair receipt requires applied_at, transaction_id, and controlled_updates.',
      });
    }
  });
type PhaseRepairReceipt = z.infer<typeof PhaseRepairReceiptSchema>;
type RepairSpec = z.infer<typeof RepairSpecSchema>;

interface TddRedEvidence {
  task_id: string;
  commands: CommandEvidence[];
}

const TddRedRetrySchema = z.object({
  schema_version: z.literal(1),
  logical_task_id: z.string().min(1),
  task_id: z.string().min(1),
  replacement_count: z.number().int().min(1),
  rejected_generation: z.number().int().min(1),
  reason: z.string().min(1),
});
type TddRedRetry = z.infer<typeof TddRedRetrySchema>;

const TEST_PATH_PATTERN =
  /(^|\/)(__tests__|tests?|spec)(\/|\.|$)|\.(test|spec)\.[^.]+$/i;

function isTestPath(relativePath: string): boolean {
  return TEST_PATH_PATTERN.test(relativePath);
}

function isTestHarnessPath(relativePath: string): boolean {
  const base = path.posix.basename(relativePath);
  return (
    isTestPath(relativePath) ||
    base === 'package.json' ||
    base === 'package-lock.json' ||
    /^(vitest|jest|playwright|cypress|tsconfig)(\.|$)/i.test(base)
  );
}

function validateProjectToolingBinding(
  projectRoot: string,
  workspaceRoot: string,
): string[] {
  const binding = readJsonIfExists<{
    isolated?: boolean;
    manifest?: string;
    lockfile?: string;
    rijo_version?: string;
  }>(path.join(projectRoot, '.rijo', 'tooling-binding.json'));
  if (
    !binding ||
    binding.isolated ||
    binding.manifest !== 'package.json' ||
    binding.lockfile !== 'package-lock.json'
  ) {
    return [];
  }

  let manifest: {
    devDependencies?: Record<string, string>;
  } | null;
  let lock: {
    packages?: Record<
      string,
      {
        version?: string;
        devDependencies?: Record<string, string>;
      }
    >;
  } | null;
  try {
    manifest = readJsonIfExists<{
      devDependencies?: Record<string, string>;
    }>(path.join(workspaceRoot, 'package.json'));
  } catch {
    return ['package.json must contain valid JSON and preserve the project-local RIJO dependency.'];
  }
  try {
    lock = readJsonIfExists<{
      packages?: Record<
        string,
        {
          version?: string;
          devDependencies?: Record<string, string>;
        }
      >;
    }>(path.join(workspaceRoot, 'package-lock.json'));
  } catch {
    return ['package-lock.json must contain valid JSON and preserve the project-local RIJO dependency.'];
  }
  const expected = binding.rijo_version;
  const manifestVersion = manifest?.devDependencies?.['rijo'];
  const lockRequirement = lock?.packages?.['']?.devDependencies?.['rijo'];
  const lockVersion = lock?.packages?.['node_modules/rijo']?.version;
  const issues: string[] = [];
  if (manifestVersion !== expected) {
    issues.push(
      `package.json must preserve the project-local RIJO devDependency at exact version ${expected ?? 'unknown'}, but the worker returned ${manifestVersion ?? 'no RIJO dependency'}.`,
    );
  }
  if (lockRequirement !== expected) {
    issues.push(
      `package-lock.json must preserve the root RIJO devDependency at exact version ${expected ?? 'unknown'}, but the worker returned ${lockRequirement ?? 'no RIJO dependency'}.`,
    );
  }
  if (lockVersion !== expected) {
    issues.push(
      `package-lock.json must preserve the installed RIJO package at exact version ${expected ?? 'unknown'}, but the worker returned ${lockVersion ?? 'no RIJO package'}.`,
    );
  }
  return issues;
}

function tddRedRetryPath(
  ctx: WorkflowContext,
  milestoneId: string,
  phaseId: string,
  taskId: string,
): string {
  return path.join(
    ctx.paths.runtimeDir,
    'tdd-red-retries',
    `${milestoneId}-${phaseId}-${taskId}.json`,
  );
}

function readTddRedRetry(target: string): TddRedRetry | null {
  const parsed = TddRedRetrySchema.safeParse(readJsonIfExists<unknown>(target));
  return parsed.success ? parsed.data : null;
}

function tddRedCorrectionNotes(reason: string): string {
  return [
    'The prior result failed deterministic TDD RED validation.',
    reason,
    'Return a corrected test and implementation.',
    'Make the test fail for the missing behavior before the implementation exists.',
    'Include every declared test file in the result.',
  ].join(' ');
}

export function normalizeResearchCheckedAt(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

export const PhaseResearchPayloadSchema = z.object({
  summary: z.string().min(1),
  volatile_facts: looseBool(true),
  sources: z
    .array(
      z.object({
        claim: z.string().min(1),
        source: z.string().min(1),
        url: z.string().url(),
        checked_at: z
          .string()
          .transform(normalizeResearchCheckedAt)
          .pipe(z.string().datetime({ offset: true })),
        version: z.string().min(1),
        tier: z.literal('official'),
      }),
    )
    .default([]),
});

const PhaseRecoveryBaselineSchema = z.object({
  snapshot: z.array(z.tuple([z.string(), z.string()])),
  controlled_snapshot: z.array(z.tuple([z.string(), z.string()])),
  dirty_at_start: z.array(z.string()),
});

const PlanInvalidationSchema = z.object({
  schema_version: z.literal(1),
  milestone: z.string(),
  phase: z.string(),
  plan_path: z.string(),
  status: z.enum(['INVALIDATED', 'REPLANNED']),
  reasons: z.array(z.string()).min(1),
  old_plan_hash: z.string().nullable(),
  new_plan_hash: z.string().nullable(),
  invalidated_at: z.string().datetime(),
  replanned_at: z.string().datetime().nullable(),
});

const PlanApprovalSchema = z.object({
  schema_version: z.literal(1),
  milestone: z.string(),
  phase: z.string(),
  plan_contract_hash: z.string().regex(/^[a-f0-9]{64}$/),
  approved_at: z.string().datetime(),
});

const PlanCycleStateSchema = z.object({
  schema_version: z.literal(1),
  phase: z.string(),
  revision: z.number().int().min(0),
  step: z.enum(['PLAN', 'REVIEW', 'APPROVED']),
  review_notes: z.array(z.string()),
  updated_at: z.string().datetime(),
});
type PlanCycleState = z.infer<typeof PlanCycleStateSchema>;

function planInvalidationPath(ctx: WorkflowContext, milestone: string, phase: string): string {
  return path.join(ctx.paths.runtimeDir, 'plan-invalidations', `${milestone}-${phase}.json`);
}

function planApprovalPath(ctx: WorkflowContext, milestone: string, phase: string): string {
  return path.join(ctx.paths.runtimeDir, 'plan-approvals', `${milestone}-${phase}.json`);
}

function planCycleStatePath(phaseDir: string): string {
  return path.join(phaseDir, 'PLAN-CYCLE.json');
}

interface PendingPlanCycleAttempt {
  step: 'PLAN' | 'REVIEW';
  revision: number;
  review_notes: string[];
  logical_task_id: string;
}

type PendingPlanCycleRecovery =
  | { status: 'none' }
  | { status: 'invalid'; logical_task_id: string; reason: string }
  | { status: 'ok'; attempt: PendingPlanCycleAttempt };

function recoverPlannerReviewNotes(notes: string, revision: number): string[] | null {
  if (revision === 0) return [];
  const start = 'Previous review issues to address within the active phase boundary:\n';
  const end =
    '\nA reviewer finding does not expand the phase. If it asks for an outcome assigned to a later phase, preserve the roadmap boundary instead of adding that work.';
  const startIndex = notes.indexOf(start);
  if (startIndex < 0) return null;
  const bodyStart = startIndex + start.length;
  const endIndex = notes.indexOf(end, bodyStart);
  if (endIndex < 0) return null;
  return notes
    .slice(bodyStart, endIndex)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function pendingPlanCycleAttempt(
  ctx: WorkflowContext,
  phase: string,
): PendingPlanCycleRecovery {
  const escapedPhase = phase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(plan|plan-review)-${escapedPhase}-r(\\d+)$`);
  const records = new TaskStore(ctx.paths)
    .listNonTerminal()
    .filter(
      (record) =>
        record.workflow_epoch === ctx.workflowEpoch &&
        ['STARTING', 'RUNNING', 'AWAITING_NATIVE_RESULT', 'REPLACING'].includes(
          record.state,
        ),
    )
    .flatMap((record) => {
      const match = pattern.exec(record.logical_task_id);
      if (!match) return [];
      const revision = Number(match[2]);
      if (!Number.isSafeInteger(revision) || revision > ctx.config.limits.plan_revisions) {
        return [];
      }
      return [{ record, step: match[1] === 'plan-review' ? ('REVIEW' as const) : ('PLAN' as const), revision }];
    })
    .sort((left, right) => right.revision - left.revision);
  const pending = records[0];
  if (!pending) return { status: 'none' };
  const requestLog = readTextIfExists(path.join(ctx.paths.runtimeDir, 'native-requests.jsonl'));
  const request = requestLog
    ?.split(/\r?\n/)
    .filter(Boolean)
    .reverse()
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return value['workflow_epoch'] === ctx.workflowEpoch &&
          value['logical_task_id'] === pending.record.logical_task_id
          ? [value]
          : [];
      } catch {
        return [];
      }
    })[0];
  if (!request) {
    return {
      status: 'invalid',
      logical_task_id: pending.record.logical_task_id,
      reason: 'The exact native request is missing from native-requests.jsonl.',
    };
  }
  const notes =
    pending.step === 'PLAN'
      ? recoverPlannerReviewNotes(
          typeof request['notes'] === 'string' ? request['notes'] : '',
          pending.revision,
        )
      : [];
  if (notes === null) {
    return {
      status: 'invalid',
      logical_task_id: pending.record.logical_task_id,
      reason: 'The planner correction notes cannot be reconstructed from the exact native request.',
    };
  }
  return {
    status: 'ok',
    attempt: {
      step: pending.step,
      revision: pending.revision,
      review_notes: notes,
      logical_task_id: pending.record.logical_task_id,
    },
  };
}

function writePlanInvalidation(
  ctx: WorkflowContext,
  milestone: string,
  phase: string,
  planPath: string,
  reasons: string[],
): void {
  writeJsonAtomic(
    planInvalidationPath(ctx, milestone, phase),
    PlanInvalidationSchema.parse({
      schema_version: 1,
      milestone,
      phase,
      plan_path: path.relative(ctx.projectRoot, planPath).split(path.sep).join('/'),
      status: 'INVALIDATED',
      reasons,
      old_plan_hash: exists(planPath) ? sha256File(planPath) : null,
      new_plan_hash: null,
      invalidated_at: ctx.now().toISOString(),
      replanned_at: null,
    }),
  );
  fs.rmSync(planApprovalPath(ctx, milestone, phase), { force: true });
  ctx.planHooks.afterInvalidated?.();
}

function markPlanReplanned(
  ctx: WorkflowContext,
  milestone: string,
  phase: string,
  planPath: string,
): void {
  const target = planInvalidationPath(ctx, milestone, phase);
  const marker = PlanInvalidationSchema.safeParse(readJsonIfExists<unknown>(target));
  if (!marker.success || marker.data.status !== 'INVALIDATED') return;
  writeJsonAtomic(target, {
    ...marker.data,
    status: 'REPLANNED',
    new_plan_hash: sha256File(planPath),
    replanned_at: ctx.now().toISOString(),
  });
  ctx.planHooks.afterReplanned?.();
}

function phaseRecoveryBaselinePath(ctx: WorkflowContext, milestone: string, phase: string): string {
  return path.join(ctx.paths.runtimeDir, 'phase-baselines', `${milestone}-${phase}.json`);
}

function phaseRepairReceiptPath(pp: PhasePaths): string {
  return path.join(pp.dir, 'REPAIR.json');
}

function readPhaseRepairReceipt(pp: PhasePaths): PhaseRepairReceipt | null {
  const parsed = PhaseRepairReceiptSchema.safeParse(
    readJsonIfExists<unknown>(phaseRepairReceiptPath(pp)),
  );
  return parsed.success ? parsed.data : null;
}

function persistPhaseRepairReceipt(
  ctx: WorkflowContext,
  pp: PhasePaths,
  receipt: PhaseRepairReceipt,
): void {
  persistPhaseGateFile(
    ctx,
    phaseRepairReceiptPath(pp),
    `${JSON.stringify(PhaseRepairReceiptSchema.parse(receipt), null, 2)}\n`,
  );
}

function appliedPhaseRepairReceipt(
  receipt: PhaseRepairReceipt,
  patch: PendingTaskPatch,
  appliedAt: string,
): PhaseRepairReceipt {
  const cumulative = new Map(
    (receipt.controlled_updates ?? []).map((update) => [update.path, update]),
  );
  for (const update of patch.controlled_updates) cumulative.set(update.path, update);
  return PhaseRepairReceiptSchema.parse({
    ...receipt,
    status: 'APPLIED',
    applied_at: appliedAt,
    transaction_id: patch.transaction_id,
    controlled_updates: [...cumulative.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  });
}

function validateAppliedRepairReceipt(
  receipt: PhaseRepairReceipt,
  projectRoot: string,
  controlledSnapshot: FileSnapshot,
  currentSnapshot: FileSnapshot,
): string[] {
  if (receipt.status !== 'APPLIED') return [];
  const updates = receipt.controlled_updates ?? [];
  const issues: string[] = [];
  for (const update of updates) {
    const absolute = path.join(projectRoot, update.path);
    if (update.state.kind === 'file') {
      if ((currentSnapshot.get(update.path) ?? null) !== update.state.sha256) {
        issues.push(`Current source does not match the repair receipt: ${update.path}.`);
      }
      if ((controlledSnapshot.get(update.path) ?? null) !== update.state.sha256) {
        issues.push(`The phase checkpoint does not include the repair receipt: ${update.path}.`);
      }
      continue;
    }
    if (update.state.kind === 'symlink') {
      let target: string | null = null;
      try {
        if (fs.lstatSync(absolute).isSymbolicLink()) target = fs.readlinkSync(absolute);
      } catch {
        target = null;
      }
      if (target !== update.state.target) {
        issues.push(`Current symlink does not match the repair receipt: ${update.path}.`);
      }
      if (controlledSnapshot.has(update.path)) {
        issues.push(`The phase checkpoint contains an invalid file entry for repaired symlink: ${update.path}.`);
      }
      continue;
    }
    let present = false;
    try {
      fs.lstatSync(absolute);
      present = true;
    } catch {
      present = false;
    }
    if (present) {
      issues.push(`A path deleted by the repair is present: ${update.path}.`);
    }
    if (controlledSnapshot.has(update.path)) {
      issues.push(`The phase checkpoint still contains a path deleted by the repair: ${update.path}.`);
    }
  }
  return issues;
}

function repairTaskDraft(
  ctx: WorkflowContext,
  pp: PhasePaths,
  plan: PhasePlan,
  spec: RepairSpec,
): AgentTaskDraft {
  return {
    id: spec.id,
    role: 'worker',
    objective: `${spec.objective} You MAY use the host's local file-inspection and patch/edit tools inside the isolated workspace. If a required dependency or active phase artifact is absent from the isolated workspace, read its project-root copy as read-only context. Preserve the exact project-local RIJO dependency in package.json and package-lock.json. Write only inside the isolated workspace. Do not edit the phase plan during a code repair. Do NOT execute repository code or run verification commands, tests, npm, git, network tools, or project processes yourself; the framework re-runs verification after you finish. Edit the code in your write scope and return ok:true; report ok:false ONLY if you genuinely could not make the change (never merely because you could not run the tests).`,
    canonical_files: [pp.plan].filter(exists),
    code_files: plan.tasks.flatMap((task) =>
      task.files.map((file) => path.resolve(ctx.projectRoot, file)),
    ),
    write_scope: plan.tasks.flatMap((task) => task.write_scope),
    acceptance_criteria: spec.acceptance,
    verification_commands: spec.commands,
    return_format: 'JSON payload: {done: boolean, notes: string}',
    notes: spec.notes,
    workspace: null,
    canonical_baseline: null,
  };
}

function recoverLegacyPendingReviewRepair(
  ctx: WorkflowContext,
  pp: PhasePaths,
  phaseId: string,
  plan: PhasePlan,
): PhaseRepairReceipt | null {
  const reviewText = readTextIfExists(pp.review);
  if (!reviewText) return null;
  const data = parseFrontmatter<Record<string, unknown>>(reviewText).data;
  if (data['gate_status'] === 'ACCEPTED') return null;
  const review = ReviewPayloadSchema.safeParse({
    approved: data['approved'],
    findings: data['findings'],
  });
  const priorLoop = z.number().int().min(0).safeParse(data['loop']);
  if (!review.success || !priorLoop.success) return null;
  const blockingSeverities = new Set(['blocker', 'critical', 'high']);
  const actionable = review.data.findings.filter(
    (finding) =>
      !['defer', 'reject'].includes(finding.type) &&
      blockingSeverities.has(finding.severity),
  );
  if (actionable.length === 0) return null;
  const loop = priorLoop.data + 1;
  const id = `review-fix-${phaseId}-l${loop}`;
  const spec = RepairSpecSchema.parse({
    id,
    objective: 'Address the valid review findings below with minimal coherent changes.',
    acceptance: ['Findings addressed', 'Verification commands still pass'],
    commands: [],
    notes: actionable
      .map(
        (finding) =>
          `${finding.type}/${finding.severity}: ${finding.description}${
            finding.file ? ` (${finding.file})` : ''
          }`,
      )
      .join('\n'),
  });
  const record = new TaskStore(ctx.paths).read(id);
  if (
    !record ||
    record.workflow_epoch !== ctx.workflowEpoch ||
    record.logical_task_id !== id ||
    record.role !== 'worker' ||
    record.task_hash === null ||
    record.workspace_path === null ||
    !['STARTING', 'RUNNING', 'AWAITING_NATIVE_RESULT', 'REPLACING'].includes(
      record.state,
    )
  ) {
    return null;
  }
  const workspaceRoot = record.workspace_path;
  const workspaceId = record.workspace_id ?? path.basename(workspaceRoot);
  const remap = (target: string): string => {
    const relative = path.relative(ctx.projectRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return target;
    return path.join(workspaceRoot, relative);
  };
  const draft = repairTaskDraft(ctx, pp, plan, spec);
  const expectedTask = AgentTaskSchema.parse(
    prepareDispatchedTask(
      ctx.config,
      {
        ...draft,
        canonical_files: (draft.canonical_files ?? []).map(remap),
        code_files: (draft.code_files ?? []).map(remap),
        workspace: { id: workspaceId, root: workspaceRoot },
        canonical_baseline: record.canonical_baseline_hash,
      },
      { stage: 'EXECUTE' },
    ),
  );
  if (supervisedTaskHash(expectedTask) !== record.task_hash) return null;
  return PhaseRepairReceiptSchema.parse({
    version: 1,
    phase: phaseId,
    kind: 'review',
    loop,
    status: 'PENDING',
    task: spec,
    created_at: ctx.now().toISOString(),
    controlled_updates: [],
  });
}

function writePhaseRecoveryBaseline(
  target: string,
  snapshot: FileSnapshot,
  dirtyAtStart: Set<string>,
  controlledSnapshot: FileSnapshot,
): void {
  writeFileAtomic(
    target,
    `${JSON.stringify(
      {
        snapshot: [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right)),
        controlled_snapshot: [...controlledSnapshot.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        dirty_at_start: [...dirtyAtStart].sort(),
      },
      null,
      2,
    )}\n`,
  );
}

export function readPhaseExecutionBaseline(
  target: string,
): { snapshot: FileSnapshot; controlledSnapshot: FileSnapshot; dirtyAtStart: Set<string> } | null {
  const raw = readTextIfExists(target);
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PhaseRecoveryBaselineSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    snapshot: new Map(parsed.data.snapshot),
    controlledSnapshot: new Map(parsed.data.controlled_snapshot),
    dirtyAtStart: new Set(parsed.data.dirty_at_start),
  };
}

const UiSmokePayloadSchema = z.object({
  passed: looseBool(false),
  console_errors: z.array(z.string()).default([]),
  network_errors: z.array(z.string()).default([]),
  screenshot: z.string().nullable().default(null),
  notes: z.string().default(''),
});

const DecisionDispatchReceiptSchema = z.object({
  task_id: z.string().min(1),
  workflow_epoch: WorkflowEpochSchema,
  attempt_id: z.string().min(1),
  generation: z.number().int().min(1),
  lease_id: z.string().min(1),
  decision_proposals: z.array(DecisionProposalSchema),
});
type DecisionDispatchReceipt = z.infer<typeof DecisionDispatchReceiptSchema>;

const AcceptedReviewGateSchema = ReviewPayloadSchema.extend({
  gate_status: z.literal('ACCEPTED'),
  review_input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  loop: z.number().int().min(0),
  decision_dispatches: z.array(DecisionDispatchReceiptSchema).default([]),
});

const UiSmokeReceiptSchema = z.object({
  version: z.literal(2),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  recorded_at: z.string().datetime({ offset: true }),
  result: UiSmokePayloadSchema,
  screenshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  screenshot_size: z.number().int().positive(),
  screenshot_media_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  decision_dispatches: z.array(DecisionDispatchReceiptSchema).default([]),
});

export async function runWorkflow(
  projectRoot: string,
  opts: RunOptions = {},
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  if (!exists(ctx.paths.manifest)) {
    return failed(ctx, 'No RIJO project here. Run `rijo new @PLAN.md` first.');
  }
  const autonomous = Boolean(ctx.durable) && (opts.finalCheck ?? (opts.target === undefined || opts.target === 'all'));
  return withLock(ctx, () => runCore(ctx, opts), {
    terminal: autonomous,
  });
}

/** Native public implementation route. Full product QA remains a separate step. */
export async function startWorkflow(
  projectRoot: string,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  return runWorkflow(projectRoot, { target: 'all', finalCheck: false }, deps);
}

/**
 * Run the phase state machine using an EXISTING context and lock. This is what
 * `rijo new --run` composes with, so the run does not try to re-acquire a lock
 * the enclosing `new` already holds.
 */
export async function runCore(ctx: WorkflowContext, opts: RunOptions = {}): Promise<WorkflowOutcome> {
  const { paths, bus } = ctx;
  const autonomous = Boolean(ctx.durable) && (opts.finalCheck ?? (opts.target === undefined || opts.target === 'all'));
  {
    // ---- LOAD
    bus.emit('run.phase_load', {
      status: 'running',
      stage: 'PHASE_LOAD',
      message: '[RIJO] PHASE_LOAD',
    });
    const schemaGuard = guardSchema(ctx);
    if (schemaGuard) return schemaGuard;
    // Orphan-workspace discard and crash recovery already ran in withLock (which
    // also wraps `rijo new --run` composing runCore), so LOAD does not repeat it.
    const integrity = validateStateIntegrity(paths);
    const errors = integrity.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return blocked(ctx, 'State integrity check failed.', errors.map((e) => `${e.code}: ${e.message} — ${e.fix}`));
    }
    // Per-attempt isolation is only real if the project can be copied without
    // carrying a door out of it: a symlink whose target escapes the checkout
    // would let an attempt read and write the host filesystem. Workspace
    // creation refuses such a project anyway — reporting it here turns the
    // refusal into a BLOCKED outcome with guidance instead of an exception.
    const escaping = findEscapingSymlinks(ctx.projectRoot);
    if (escaping.length > 0) {
      return blocked(
        ctx,
        `The checkout contains symlinks whose target is absolute or leaves the project root: ${escaping.join(', ')}. ` +
          `An attempt workspace cannot isolate them.`,
        ['Remove the links or repoint them at a relative path inside the project, then re-run.'],
      );
    }
    const milestone = activeMilestone(paths);
    if (!milestone) return failed(ctx, 'No active milestone in manifest.');
    if (!exists(milestone.paths.roadmap)) return failed(ctx, `Missing ROADMAP.md for ${milestone.id}.`);

    const budget = checkContextBudget(
      [paths.rules, paths.state, milestone.paths.requirements],
      ctx.config.context_budget_bytes,
    );
    if (!budget.withinBudget) {
      bus.emit('run.budget_warning', { message: `Automatic context ${budget.bytes}B exceeds budget ${budget.budget}B.` });
    }

    const roadmap = readRoadmap(milestone.paths.roadmap);
    const targets = resolveTargets(ctx, roadmap, autonomous ? 'all' : opts.target);
    if (targets.length === 0) {
      const allDone = roadmap.phases.every((p) => p.status === 'DONE');
      if (allDone && autonomous) return runAutonomousFinalCheck(ctx);
      if (allDone) {
        syncActiveProjectProjections(paths);
        bus.emit('run.implementation_complete', {
          status: 'completed',
          stage: 'IMPLEMENTATION_COMPLETE',
          milestone: { id: milestone.id, name: milestone.slug },
          message: `[RIJO ${milestone.id}] IMPLEMENTATION_COMPLETE`,
        });
      }
      return completed(
        ctx,
        allDone ? `All ${roadmap.phases.length} phases of ${milestone.id} are DONE.` : 'No ready phase (check dependencies/blockers).',
      );
    }

    for (const phase of targets) {
      const outcome = await executePhase(ctx, milestone, phase);
      if (!outcome.ok) return outcome;
      await durableCheckpoint(ctx, `phase:${phase.id}:completed`, {
        commit: ctx.git.headCommit(ctx.projectRoot),
      });
      syncActiveProjectProjections(paths);
      if (!autonomous && opts.target !== 'all') return outcome;
    }
    if (autonomous) return runAutonomousFinalCheck(ctx);
    bus.emit('run.implementation_complete', {
      status: 'completed',
      stage: 'IMPLEMENTATION_COMPLETE',
      milestone: { id: milestone.id, name: milestone.slug },
      message: `[RIJO ${milestone.id}] IMPLEMENTATION_COMPLETE`,
    });
    return completed(ctx, `Completed ${targets.length} phase(s) of ${milestone.id}.`);
  }
}

async function runAutonomousFinalCheck(ctx: WorkflowContext): Promise<WorkflowOutcome> {
  ctx.bus.emit('run.final_check', {
    status: 'running',
    stage: 'CHECKS',
    message: 'All phases are complete. Run the bounded production check.',
  });
  await durableCheckpoint(ctx, 'run:before-final-check', {
    commit: ctx.git.headCommit(ctx.projectRoot),
  });
  const check = ctx.finalCheck ?? checkCore;
  return check(ctx, { production: true, fix: true });
}

function nativePhaseStage(
  stage: import('../core/schemas/index.js').Stage,
): import('../core/schemas/index.js').Stage {
  switch (stage) {
    case 'LOAD':
      return 'PHASE_LOAD';
    case 'RESEARCH_DELTA':
    case 'SPEC_READY':
      return 'PHASE_RESEARCH';
    case 'PLAN':
    case 'PLAN_LINT':
      return 'PHASE_PLAN';
    case 'CODE_REVIEW':
      return 'ENGINEERING_REVIEW';
    case 'UI_SMOKE':
      return 'VERIFY';
    case 'PERSIST':
    case 'COMMIT':
    case 'DONE':
      return 'PHASE_DONE';
    default:
      return stage;
  }
}

function resolveTargets(ctx: WorkflowContext, roadmap: RoadmapDoc, target?: string): RoadmapPhase[] {
  if (target && /^\d{2}$/.test(target)) {
    const phase = roadmap.phases.find((p) => p.id === target);
    if (!phase) throw new Error(`Phase ${target} not found in roadmap`);
    return phase.status === 'DONE' ? [] : [phase];
  }
  if (target === 'all') {
    // sequential order respecting deps: repeatedly pick next ready
    const list: RoadmapPhase[] = [];
    const sim = new Set(roadmap.phases.filter((p) => p.status === 'DONE').map((p) => p.id));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const p of roadmap.phases) {
        if (p.status === 'DONE' || sim.has(p.id) || list.includes(p)) continue;
        if (p.depends_on.every((d) => sim.has(d))) {
          list.push(p);
          sim.add(p.id);
          progressed = true;
        }
      }
    }
    return list;
  }
  // resume from STATE.md, else next ready
  const state = readState(ctx.paths);
  if (!target && state?.phase) {
    const phase = roadmap.phases.find((p) => p.id === state.phase && p.status !== 'DONE');
    if (phase) return [phase];
  }
  const np = nextPhase(roadmap);
  return np ? [np] : [];
}

async function executePhase(
  ctx: WorkflowContext,
  milestone: MilestoneRef,
  phase: RoadmapPhase,
): Promise<WorkflowOutcome> {
  const { paths, bus, config, now } = ctx;
  const roadmap = readRoadmap(milestone.paths.roadmap);
  const phaseIndex = roadmap.phases.findIndex((p) => p.id === phase.id) + 1;
  const phaseDir = path.join(milestone.paths.phasesDir, `${phase.id}-${phase.slug}`);
  ensureDir(phaseDir);
  const pp = phasePaths(phaseDir);
  const phaseInfo = { id: phase.id, index: phaseIndex, total: roadmap.phases.length, name: phase.name };
  const milestoneInfo = { id: milestone.id, name: milestone.slug };
  const stage = (s: import('../core/schemas/index.js').Stage, message: string, extra: Record<string, unknown> = {}) => {
    const publicStage = nativePhaseStage(s);
    return bus.emit(
      `run.${publicStage.toLowerCase()}`,
      {
        status: 'running',
        stage: publicStage,
        milestone: milestoneInfo,
        phase: phaseInfo,
        message: `[RIJO ${milestone.id} F${phase.id}/${String(roadmap.phases.length).padStart(2, '0')}] ${publicStage}`,
      },
      { ...extra, detail: message },
    );
  };

  const markPhase = (status: RoadmapPhase['status'], commit?: string | null) => {
    const doc = readRoadmap(milestone.paths.roadmap);
    const p = doc.phases.find((x) => x.id === phase.id)!;
    p.status = status;
    if (commit !== undefined) p.commit = commit;
    writeRoadmap(milestone.paths.roadmap, doc);
  };

  /** Append-only transition event FIRST, then the plan projection, then manifest hashes. */
  const transition = (taskId: string, to: TaskStatus, reason = '') => {
    bus.emit('task.transition', { message: `Task ${taskId} → ${to}${reason ? ` (${reason})` : ''}` }, { task: taskId, to, reason });
    setTaskStatus(pp.plan, taskId, to);
    touchManifest(paths, () => {}, now);
  };

  let forceReplan = false;
  let appliedPlanAtEntry = false;
  let durablePlanAtEntry: PhasePlan | null = null;
  if (exists(pp.plan)) {
    try {
      durablePlanAtEntry = readPlan(pp.plan);
    } catch {
      // Legacy/corrupt plans are handled by the explicit migration path below.
    }
  }
  if (readMapState(paths)) {
    stage('LOAD', 'Check map and plan freshness before the phase starts.');
    const rawPlanData = exists(pp.plan)
      ? parseFrontmatter<Record<string, unknown>>(readText(pp.plan)).data
      : null;
    const rawTasks = Array.isArray(rawPlanData?.['tasks'])
      ? (rawPlanData!['tasks'] as Array<Record<string, unknown>>)
      : [];
    const hasAppliedProgress = rawTasks.some((task) =>
      ['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(String(task['status'] ?? 'PENDING')),
    );
    appliedPlanAtEntry = hasAppliedProgress;
    let allowedDirtyPaths = ctx.git
      .status(ctx.projectRoot)
      .dirtyFiles.filter((dirtyPath) => dirtyPath === '.rijo' || dirtyPath.startsWith('.rijo/'));
    if (hasAppliedProgress) {
      const recovery = readPhaseExecutionBaseline(
        phaseRecoveryBaselinePath(ctx, milestone.id, phase.id),
      );
      if (!recovery) {
        return blocked(ctx, `Phase ${phase.id}: source baseline needed for safe freshness recovery is missing.`, [
          'The existing plan records applied tasks, but RIJO cannot distinguish controlled work from external changes.',
        ]);
      }
      const externalDelta = diffSnapshots(recovery.controlledSnapshot, snapshotFiles(ctx.projectRoot));
      const writeScopes = rawTasks.flatMap((task) =>
        Array.isArray(task['write_scope']) ? (task['write_scope'] as string[]) : [],
      );
      const overlapping = externalDelta.changed.filter((changed) =>
        writeScopes.some((scope) => pathInScope(changed, [scope])),
      );
      if (overlapping.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: external changes overlap the existing plan.`, [
          `Conflicting paths: ${overlapping.join(', ')}`,
          'RIJO did not appropriate, overwrite, or revert these paths.',
        ]);
      }
      allowedDirtyPaths = ctx.git.status(ctx.projectRoot).dirtyFiles;
      if (externalDelta.changed.length > 0) {
        bus.emit(
          'run.external_change_non_overlapping',
          { message: `Recorded an unrelated external change for phase ${phase.id}.` },
          { phase: phase.id, paths: externalDelta.changed },
        );
      }
    }
    const ensured = await ensureCodebaseMap(ctx, {
      commit: true,
      ...(allowedDirtyPaths.length > 0 ? { allowedDirtyPaths } : {}),
    });
    if (!ensured.outcome.ok) return ensured.outcome;
    if (!ensured.state || ensured.state.status === 'BLOCKED') {
      return blocked(ctx, `Phase ${phase.id}: current codebase map is not safe for planning.`, [
        `Map status: ${ensured.state?.status ?? 'missing'}.`,
        ...(ensured.state?.gaps ?? []),
      ]);
    }
    const phaseRequirements = readRequirements(milestone.paths.requirements).requirements.filter(
      (requirement) => requirement.phase === phase.id,
    );
    const phaseScope = [
      phase.name,
      ...phaseRequirements.flatMap((requirement) => [requirement.description, requirement.acceptance]),
    ].join('\n');
    const affectingGaps =
      ensured.state.gap_records.length > 0
        ? structuredGapsAffectingScope(ensured.state.gap_records, phaseScope)
        : gapsAffectingScope(ensured.state.gaps, phaseScope);
    if (ensured.state.status === 'PARTIAL' && affectingGaps.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: codebase map gaps intersect the phase scope.`, affectingGaps);
    }
    if (exists(pp.plan)) {
      const marker = PlanInvalidationSchema.safeParse(
        readJsonIfExists<unknown>(planInvalidationPath(ctx, milestone.id, phase.id)),
      );
      if (marker.success && marker.data.status === 'INVALIDATED') {
        forceReplan = true;
      } else {
        let existingPlan: PhasePlan | null = null;
        try {
          existingPlan = readPlan(pp.plan);
        } catch (error) {
          if (hasAppliedProgress) {
            return blocked(ctx, `Phase ${phase.id}: an applied legacy plan cannot be migrated safely.`, [
              error instanceof Error ? error.message : String(error),
            ]);
          }
          writePlanInvalidation(ctx, milestone.id, phase.id, pp.plan, [
            'LEGACY_PLAN_SCHEMA: mapped references or freshness metadata are missing',
          ]);
          forceReplan = true;
        }
        if (existingPlan) {
          const packet = buildContextPacket(ctx.projectRoot, phaseScope, config.context_budget_bytes, now);
          const referenceIssues = validatePlanMapReferences(ctx.projectRoot, existingPlan).filter((issue) => {
            if (!hasAppliedProgress) return true;
            const task = existingPlan!.tasks.find((candidate) => candidate.id === issue.task_id);
            if (!task || !['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(task.status)) return true;
            return !task.write_scope.some((scope) => issue.message.includes(scope));
          });
          const declaredReferenceHashes = Object.fromEntries(
            existingPlan.tasks.flatMap((task) =>
              task.mapped_references
                .filter((reference) => reference.intent === 'existing')
                .map((reference) => [reference.path, reference.file_hash]),
            ),
          );
          const freshnessReasons = [
            ...(existingPlan.mapped_commit !== ensured.state.mapped_commit
              ? [`mapped_commit changed (${existingPlan.mapped_commit} -> ${ensured.state.mapped_commit})`]
              : []),
            ...(existingPlan.mapped_tree_hash !== ensured.state.mapped_tree_hash
              ? ['mapped_tree_hash changed']
              : []),
            ...(existingPlan.context_packet_hash !== packet.packet_hash
              ? ['context_packet_hash changed']
              : []),
            ...(existingPlan.decision_context_hash !== packet.decision_context_hash
              ? ['decision_context_hash changed']
              : []),
            ...(JSON.stringify(existingPlan.mapped_reference_hashes) !== JSON.stringify(declaredReferenceHashes)
              ? ['mapped_reference_hashes do not match the plan references']
              : []),
            ...referenceIssues.map((issue) => `${issue.code}: ${issue.message}`),
          ];
          if (freshnessReasons.length > 0) {
            const overlappingReferences = referenceIssues.filter((issue) =>
              ['MAP_HASH_MISMATCH', 'MAP_SYMBOL_NOT_FOUND', 'MAP_PATH_NOT_FOUND', 'MAP_INTENT_MISMATCH'].includes(
                issue.code,
              ),
            );
            if (hasAppliedProgress && overlappingReferences.length > 0) {
              return blocked(ctx, `Phase ${phase.id}: mapped references changed after tasks were applied.`, [
                ...overlappingReferences.map((issue) => issue.message),
                'Recovery is not deterministic; the controlled checkout was left unchanged.',
              ]);
            }
            if (!hasAppliedProgress) {
              writePlanInvalidation(ctx, milestone.id, phase.id, pp.plan, freshnessReasons);
              forceReplan = true;
            } else {
              bus.emit(
                'run.plan_freshness_reconciled',
                { message: `Reconciled the applied phase ${phase.id} plan with a non-overlapping external change.` },
                { reasons: freshnessReasons },
              );
            }
          }
        }
      }
    }
    bus.emit(
      'run.map_context_fresh',
      { message: `Phase ${phase.id} will use map ${ensured.state.mapped_commit}.` },
      {
        phase: phase.id,
        mapped_commit: ensured.state.mapped_commit,
        mapped_tree_hash: ensured.state.mapped_tree_hash,
        last_operation: ensured.state.last_operation,
        changed_paths: ensured.state.changed_paths_since_map,
      },
    );
  }

  // Record which files were ALREADY dirty before this phase ran: a phase commit
  // must never appropriate pre-existing user changes, and overlapping paths are
  // an explicit conflict rather than a silent sweep.
  const gitStatusAtStart = ctx.git.status(ctx.projectRoot);
  const initialDirtyAtStart = new Set(gitStatusAtStart.dirtyFiles);

  markPhase('IN_PROGRESS');
  touchManifest(paths, () => {}, now);

  // ---- PHASE_RESEARCH (bounded, read-only, persisted by the deterministic core)
  stage('RESEARCH_DELTA', 'Research the current phase delta.');
  if (!exists(pp.research)) {
    const reqDoc = readRequirements(milestone.paths.requirements);
    const phaseReqs = reqDoc.requirements.filter((requirement) => requirement.phase === phase.id);
    let researchPayload: z.infer<typeof PhaseResearchPayloadSchema> | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const researchTask: AgentTaskDraft = {
        id: `new-research-phase-${phase.id}-r${attempt}`,
        role: 'researcher',
        objective:
          `Research only the implementation delta for phase ${phase.id} (${phase.name}). ` +
          'Use official primary documentation for volatile facts. Do not modify the checkout.',
        canonical_files: [
          paths.rules,
          milestone.paths.scope,
          milestone.paths.requirements,
          milestone.paths.research,
        ].filter(exists),
        code_files: [],
        write_scope: [],
        acceptance_criteria: [
          'Limit research to the active phase.',
          'Provide an official source for every volatile fact.',
          'Record each source claim, URL, checked date, and version.',
        ],
        verification_commands: [],
        return_format:
          'JSON payload: {summary, volatile_facts, sources:[{claim,source,url,checked_at,version,tier:"official"}]}. ' +
          'Set volatile_facts=false only when the phase has no version-sensitive fact.',
        notes: phaseReqs
          .map((requirement) => `${requirement.id}: ${requirement.description}\nAcceptance: ${requirement.acceptance}`)
          .join('\n\n'),
        workspace: null,
        canonical_baseline: null,
      };
      const { result, violation } = await dispatchReadOnly(ctx, researchTask, {
        stage: 'RESEARCH_DELTA',
      });
      if (violation.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: researcher modified the checkout.`, violation);
      }
      const parsed = PhaseResearchPayloadSchema.safeParse(result.payload);
      if (
        result.ok &&
        parsed.success &&
        (!parsed.data.volatile_facts || parsed.data.sources.length > 0)
      ) {
        researchPayload = parsed.data;
        commitDecisionProposals(ctx, result);
        break;
      }
      discardDecisionProposals(ctx, result);
    }
    if (!researchPayload) {
      return blocked(ctx, `Phase ${phase.id}: phase research failed after 2 attempts.`, [
        'Volatile facts require an official source with a claim, URL, checked date, and version.',
      ]);
    }
    writeFileAtomic(
      pp.research,
      serializeFrontmatter(
        {
          phase: phase.id,
          researched_at: now().toISOString(),
          volatile_facts: researchPayload.volatile_facts,
          sources: researchPayload.sources,
        },
        [
          `# Phase research — ${phase.id}`,
          '',
          researchPayload.summary,
          '',
          '## Official sources',
          ...(researchPayload.sources.length
            ? researchPayload.sources.map(
                (source) =>
                  `- ${source.claim} — ${source.source} ${source.version} (${source.url}, checked ${source.checked_at})`,
              )
            : ['- No volatile facts apply to this phase.']),
          '',
        ].join('\n'),
      ),
    );
    touchManifest(paths, () => {}, now);
  }

  // ---- PLAN + PLAN_LINT + PLAN_REVIEW (bounded loop)
  const reqDoc = readRequirements(milestone.paths.requirements);
  const knownReqs = new Set(reqDoc.requirements.map((r) => r.id));
  const planningMapContext = buildContextPacket(
    ctx.projectRoot,
    [
      phase.name,
      ...reqDoc.requirements
        .filter((requirement) => requirement.phase === phase.id)
        .flatMap((requirement) => [requirement.description, requirement.acceptance]),
    ].join('\n'),
    config.context_budget_bytes,
  );
  const activePhaseRequirementIds = reqDoc.requirements
    .filter((requirement) => requirement.phase === phase.id)
    .map((requirement) => requirement.id);
  const laterPhaseAllocations = roadmap.phases
    .slice(phaseIndex)
    .map(
      (laterPhase) =>
        `${laterPhase.id} — ${laterPhase.name}: ${laterPhase.requirements.join(', ') || 'no requirements (technical)'}`,
    );
  const phaseBoundaryContext = [
    `Active phase: ${phase.id} — ${phase.name}`,
    `Active phase requirement IDs: ${activePhaseRequirementIds.join(', ') || 'none (technical)'}`,
    'Later phase allocations:',
    ...(laterPhaseAllocations.length > 0 ? laterPhaseAllocations : ['None.']),
    'Boundary rule: REQUIREMENTS.md and ROADMAP.md own phase allocation. Apply milestone-wide RULES.md constraints to behavior changed now, but do not treat an outcome allocated to a later phase as missing from the active plan.',
  ].join('\n');
  const hasPlanningMap = readMapState(paths) !== null;
  const existingPlan: PhasePlan | null =
    exists(pp.plan) && !forceReplan ? readPlan(pp.plan) : null;
  const storedPlanCycle = PlanCycleStateSchema.safeParse(
    readJsonIfExists<unknown>(planCycleStatePath(phaseDir)),
  );
  const pendingPlanCycleRecovery = pendingPlanCycleAttempt(ctx, phase.id);
  if (pendingPlanCycleRecovery.status === 'invalid') {
    return blocked(ctx, `Phase ${phase.id}: the active native planning request cannot be recovered.`, [
      `${pendingPlanCycleRecovery.logical_task_id}: ${pendingPlanCycleRecovery.reason}`,
      'RIJO preserved the task lease and did not review a stale plan.',
    ]);
  }
  const pendingPlanCycle =
    pendingPlanCycleRecovery.status === 'ok'
      ? pendingPlanCycleRecovery.attempt
      : null;
  const planCycleFileExists = exists(planCycleStatePath(phaseDir));
  if (
    !forceReplan &&
    storedPlanCycle.success &&
    storedPlanCycle.data.phase === phase.id &&
    pendingPlanCycle &&
    (storedPlanCycle.data.step !== pendingPlanCycle.step ||
      storedPlanCycle.data.revision !== pendingPlanCycle.revision ||
      (pendingPlanCycle.step === 'PLAN' &&
        JSON.stringify(storedPlanCycle.data.review_notes) !==
          JSON.stringify(pendingPlanCycle.review_notes)))
  ) {
    return blocked(ctx, `Phase ${phase.id}: the portable plan cycle conflicts with the active native request.`, [
      `Portable cycle: ${storedPlanCycle.data.step} revision ${storedPlanCycle.data.revision}.`,
      `Native request: ${pendingPlanCycle.logical_task_id}.`,
      'RIJO preserved both records and did not reuse a stale task identity.',
    ]);
  }
  if (!forceReplan && planCycleFileExists && !storedPlanCycle.success) {
    return blocked(ctx, `Phase ${phase.id}: PLAN-CYCLE.json is invalid.`, [
      'Restore the portable planning checkpoint before resuming this phase.',
    ]);
  }
  let planCycle: PlanCycleState =
    storedPlanCycle.success && storedPlanCycle.data.phase === phase.id && !forceReplan
      ? storedPlanCycle.data
      : PlanCycleStateSchema.parse({
          schema_version: 1,
          phase: phase.id,
          revision: pendingPlanCycle?.revision ?? 0,
          step:
            forceReplan
              ? 'PLAN'
              : pendingPlanCycle
              ? pendingPlanCycle.step
              : existingPlan
                ? 'REVIEW'
                : 'PLAN',
          review_notes: forceReplan
            ? [
                'The previous plan was invalidated by deterministic freshness checks. Create a new plan from the current canonical context.',
              ]
            : pendingPlanCycle?.review_notes ?? [],
          updated_at: now().toISOString(),
        });
  let revisions = planCycle.revision;
  let reviewNotes = [...planCycle.review_notes];
  let plan: PhasePlan | null = existingPlan;
  if (planCycle.step === 'PLAN') {
    // A planning correction can pause after an older draft was written.
    // Replay the exact pending revision with its durable review notes.
    plan = null;
  }
  const persistPlanCycle = (
    step: PlanCycleState['step'],
    notes: string[] = reviewNotes,
  ): void => {
    planCycle = PlanCycleStateSchema.parse({
      schema_version: 1,
      phase: phase.id,
      revision: revisions,
      step,
      review_notes: notes,
      updated_at: now().toISOString(),
    });
    writeJsonAtomic(planCycleStatePath(phaseDir), planCycle);
    touchManifest(paths, () => {}, now);
  };
  let planApproved = false;
  const approvalTarget = planApprovalPath(ctx, milestone.id, phase.id);
  if (plan) {
    const runtimeApproval = PlanApprovalSchema.safeParse(readJsonIfExists<unknown>(approvalTarget));
    const executionStarted = plan.tasks.some((task) => task.status !== 'PENDING');
    const contractHash = planContractHash(plan);
    if (plan.approved_plan) {
      if (!hasValidPortablePlanApproval(plan)) {
        return blocked(ctx, `Phase ${phase.id}: the approved plan contract changed without invalidation.`, [
          'The durable task lifecycle was preserved. Explicitly invalidate the plan before changing task definitions.',
        ]);
      }
      planApproved = true;
    } else if (
      runtimeApproval.success &&
      runtimeApproval.data.plan_contract_hash === contractHash
    ) {
      // One-time migration from the old runtime-only marker into PLAN.md.
      plan = PhasePlanSchema.parse({
        ...plan,
        approved_plan: {
          schema_version: 1,
          plan_contract_hash: contractHash,
          approved_at: runtimeApproval.data.approved_at,
        },
      });
      writePlan(pp.plan, plan, `Generated for ${phase.name}.`);
      touchManifest(paths, () => {}, now);
      planApproved = true;
    } else if (executionStarted) {
      return blocked(ctx, `Phase ${phase.id}: in-progress plan approval provenance is missing.`, [
        'RIJO will not infer approval from mutable task statuses or the current plan hash.',
        'Restore the approved PLAN.md artifact or explicitly invalidate and review the plan.',
      ]);
    }
    if (planApproved) {
      const approvedAt = plan.approved_plan!.approved_at;
      writeJsonAtomic(
        approvalTarget,
        PlanApprovalSchema.parse({
          schema_version: 1,
          milestone: milestone.id,
          phase: phase.id,
          plan_contract_hash: contractHash,
          approved_at: approvedAt,
        }),
      );
    }
  }
  let planEnvelope: ValidatedAgentEnvelope | null = null;
  let planReviewEnvelope: ValidatedAgentEnvelope | null = null;
  while (true) {
    if (!plan) {
      stage('PLAN', `Plan tasks (revision ${revisions}).`);
      persistPlanCycle('PLAN');
      const planTask: AgentTaskDraft = {
        id: `plan-${phase.id}-r${revisions}`,
        role: 'planner',
        objective: `Produce the execution plan for phase ${phase.id}: between 3 and 6 tasks, exact files or code regions, dependencies, per-worker write scope, executable test commands and expected evidence, parallel flag only for independent tasks with disjoint write scopes. Do not create artificial tasks. Use the simplest design that supports this milestone and the next likely milestone. Reject abstractions without a consumer, duplicate layers, and speculative infrastructure. Set tdd=true for testable behavior. EVERY task must CREATE or EDIT at least one concrete source/test file — its "files" and "write_scope" arrays must each name at least one real path. Each tests[] entry must be an executable verification command such as "npm test", never a prose scenario or expected result. Do NOT emit a verification-only, evidence-only, or "run the tests" task: the framework runs verification and records evidence itself; a task that writes no file is invalid. If a task edits an existing npm package.json and package-lock.json exists, assign both files to the same task. Preserve the exact project-local RIJO devDependency and other existing tooling dependencies.`,
        canonical_files: [
          paths.rules,
          milestone.paths.scope,
          pp.research,
          milestone.paths.requirements,
          milestone.paths.roadmap,
          path.join(ctx.projectRoot, 'package.json'),
          path.join(ctx.projectRoot, 'package-lock.json'),
        ].filter(exists),
        code_files: [],
        write_scope: [],
        acceptance_criteria: ['3-6 tasks', 'every task writes at least one concrete file (non-empty files[] and write_scope[])', 'every task has requirement IDs or technical justification', 'write scopes are exact'],
        verification_commands: [],
        return_format:
          'JSON payload matching PhasePlanDraft: {phase, tasks:[{id:"T01", name, requirement_ids[], technical_justification, files[/*>=1 exact path*/], mapped_references:[{path,intent:"existing",file_hash,symbol?}|{path,intent:"new",parent_module,placement_evidence:[{path,reason}]}] /* required and must cover every task file */, write_scope[/*only exact declared files*/], depends_on[], parallel, tdd, tests[/*executable command strings only, e.g. "npm test"*/], evidence_expected}]}. ' +
          (hasPlanningMap
            ? 'Existing paths must use current hashes; new paths must extend a mapped module and cite real placement evidence.'
            : 'This is a greenfield phase with no codebase map. Existing bootstrap files such as package.json and package-lock.json must use intent:"existing" with their current SHA-256 hashes. New task files must use intent:"new", parent_module:"project-root", and placement_evidence must cite package.json as the existing project-root bootstrap contract.') +
          ' Never omit mapped_references. Put behavioral scenarios in evidence_expected, not tests[].',
        notes: [
          phaseBoundaryContext,
          planningMapContext.text,
          reviewNotes.length
            ? [
                'Previous review issues to address within the active phase boundary:',
                ...reviewNotes,
                'A reviewer finding does not expand the phase. If it asks for an outcome assigned to a later phase, preserve the roadmap boundary instead of adding that work.',
              ].join('\n')
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        workspace: null,
        canonical_baseline: null,
      };
      const { result: res, violation } = await dispatchReadOnly(ctx, planTask, { stage: 'PLAN' });
      planEnvelope = res;
      if (violation.length > 0) {
        return blocked(ctx, `Phase ${phase.id}: planner (read-only) modified the checkout.`, violation);
      }
      // A planner dispatch that the host could not deliver (ok:false — e.g. an
      // intermittent headless read-only glitch where the model produced no
      // parseable result) is RECOVERABLE, not fatal: re-plan within the same
      // plan_revisions budget rather than abandoning the phase on a transient
      // host blip. Only an exhausted budget blocks.
      if (!res.ok) {
        discardDecisionProposals(ctx, res);
        if (isWorkflowCancellation(res) || revisions >= config.limits.plan_revisions) {
          return blocked(ctx, `Phase ${phase.id}: planning failed after ${revisions} revisions.`, [res.summary]);
        }
        revisions++;
        reviewNotes = [
          `The previous planning attempt returned no usable plan (${res.summary.slice(0, 200)}). Return the plan ONLY as the JSON payload described in the return format — do not write any file.`,
        ];
        persistPlanCycle('PLAN');
        plan = null;
        continue;
      }
      const parsed = PhasePlanDraftSchema.safeParse(res.payload);
      if (!parsed.success) {
        discardDecisionProposals(ctx, res);
        // A schema-invalid plan (e.g. a task missing files/write_scope) is a
        // RECOVERABLE planner error, not a fatal one: feed the precise shape
        // violations back and re-plan within the same plan_revisions budget the
        // lint loop uses — a hard block here would abandon a phase on a mistake
        // the planner can trivially correct on the next turn.
        if (revisions >= config.limits.plan_revisions) {
          return blocked(ctx, `Phase ${phase.id}: planner returned an invalid plan after ${revisions} revisions.`, [
            parsed.error.message,
          ]);
        }
        revisions++;
        reviewNotes = parsed.error.issues.map(
          (i) => `Invalid plan payload at ${i.path.join('.') || '(root)'}: ${i.message}. Every task needs a non-empty files[] and write_scope[]; ids must be T01..T06; return a payload matching the PhasePlan schema exactly.`,
        );
        persistPlanCycle('PLAN');
        plan = null;
        continue;
      }
      plan = {
        ...parsed.data,
        phase: phase.id,
        mapped_commit: planningMapContext.mapped_commit || 'GREENFIELD',
        mapped_tree_hash: planningMapContext.mapped_tree_hash || 'GREENFIELD',
        planned_at: now().toISOString(),
        context_packet_hash: planningMapContext.packet_hash,
        mapped_reference_hashes: Object.fromEntries(
          parsed.data.tasks.flatMap((task) =>
            task.mapped_references
              .filter((reference) => reference.intent === 'existing')
              .map((reference) => [reference.path, reference.file_hash]),
          ),
        ),
        decision_context_hash: planningMapContext.decision_context_hash,
      };
      plan = preserveEquivalentPlanProgress(durablePlanAtEntry, plan);
      // The PLAN is a canonical artifact written by the CORE from the planner's
      // validated payload — the agent never touches the plan file itself.
      writePlan(pp.plan, plan, `Generated for ${phase.name}.`);
      planApproved = false;
      ctx.planHooks.afterPlanWritten?.();
      markPlanReplanned(ctx, milestone.id, phase.id, pp.plan);
      reviewNotes = [];
      persistPlanCycle('REVIEW');
      touchManifest(paths, () => {}, now);
    }

    stage('PLAN_LINT', 'Validate the plan deterministically.');
    const phaseRequirements = reqDoc.requirements.filter((r) => r.phase === phase.id).map((r) => r.id);
    const lintIssues = lintPlan(plan, { knownRequirements: knownReqs, phaseRequirements });
    const packageManifestTask = plan.tasks.find((task) =>
      task.write_scope.includes('package.json'),
    );
    if (
      packageManifestTask &&
      exists(path.join(ctx.projectRoot, 'package-lock.json')) &&
      (!packageManifestTask.files.includes('package-lock.json') ||
        !packageManifestTask.write_scope.includes('package-lock.json'))
    ) {
      lintIssues.push({
        code: 'NPM_LOCK_SCOPE',
        message: `${packageManifestTask.id}: package.json changes can update the existing package-lock.json during the managed dependency gate.`,
        fix: `Add package-lock.json to ${packageManifestTask.id}.files, mapped_references, and write_scope so the generated lockfile is authorized and committed.`,
      });
    }
    if (
      packageManifestTask &&
      exists(path.join(ctx.projectRoot, 'package-lock.json'))
    ) {
      const lockReference = packageManifestTask.mapped_references.find(
        (reference) => reference.path === 'package-lock.json',
      );
      const currentLockHash = sha256File(
        path.join(ctx.projectRoot, 'package-lock.json'),
      );
      if (
        !lockReference ||
        lockReference.intent !== 'existing' ||
        lockReference.file_hash !== currentLockHash
      ) {
        lintIssues.push({
          code: 'NPM_LOCK_REFERENCE',
          message: `${packageManifestTask.id}: the existing package-lock.json mapped reference is missing or stale.`,
          fix: `Use intent:"existing" and current SHA-256 ${currentLockHash} for package-lock.json.`,
        });
      }
    }
    if (!exists(path.join(ctx.projectRoot, 'package.json'))) {
      const packageOwner = plan.tasks.find((task) => task.write_scope.includes('package.json'));
      if (packageOwner) {
        for (const task of plan.tasks) {
          const needsPackageBeforeRed =
            task.id !== packageOwner.id &&
            task.tdd &&
            task.write_scope.some(isTestPath) &&
            task.tests.some((command) => /^npm(?:\s|$)/.test(command));
          if (needsPackageBeforeRed && !task.depends_on.includes(packageOwner.id)) {
            lintIssues.push({
              code: 'TDD_RED_MISSING_SETUP',
              message: `${task.id}: the RED command needs package.json from ${packageOwner.id}.`,
              fix: `Add ${packageOwner.id} to ${task.id}.depends_on so the framework can run a meaningful RED test.`,
            });
          }
        }
      }
    }
    const mapReferenceIssues = (readMapState(paths) ? validatePlanMapReferences(ctx.projectRoot, plan) : [])
      .filter((issue) => {
        if (!appliedPlanAtEntry) return true;
        const task = plan!.tasks.find((candidate) => candidate.id === issue.task_id);
        return (
          !task ||
          !['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(task.status) ||
          !task.write_scope.some((scope) => issue.message.includes(scope))
        );
      })
      .map((issue) => ({
      code: issue.code,
      message: `${issue.task_id}: ${issue.message}`,
      fix: 'Use an existing path/symbol/hash from the current codebase map, or declare a genuinely new file below an existing directory.',
      }));
    lintIssues.push(...mapReferenceIssues);
    if (lintIssues.length > 0) {
      if (planEnvelope) discardDecisionProposals(ctx, planEnvelope);
      planEnvelope = null;
      if (revisions >= config.limits.plan_revisions) {
        return blocked(ctx, `Phase ${phase.id}: plan lint failed after ${revisions} revisions.`, lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`));
      }
      revisions++;
      reviewNotes = lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`);
      persistPlanCycle('PLAN');
      plan = null;
      continue;
    }

    if (planApproved) break;

    stage('PLAN_REVIEW', 'Run an independent plan review.');
    persistPlanCycle('REVIEW');
    const reviewTask: AgentTaskDraft = {
      id: `plan-review-${phase.id}-r${revisions}`,
      role: 'reviewer',
      objective:
        'Independent brief review of the active phase plan: completeness, coherence, risk, requirement coverage, and adherence to applicable rules. ' +
        "You receive the plan, never the author's reasoning. REQUIREMENTS.md and ROADMAP.md are authoritative for phase allocation; RULES.md contains milestone-wide constraints and outcomes. " +
        'Apply rules to behavior changed by this phase, but do not report a missing feature as a spec_gap when REQUIREMENTS.md or ROADMAP.md assigns it to a later phase. ' +
        'Do not pull requirements assigned to a later phase into this plan. Reject feature coverage only when it belongs to the active phase or is a necessary prerequisite for its acceptance criteria.',
      canonical_files: [
        paths.rules,
        milestone.paths.scope,
        milestone.paths.requirements,
        milestone.paths.roadmap,
        pp.plan,
      ].filter(exists),
      code_files: [],
      write_scope: [],
      acceptance_criteria: [],
      verification_commands: [],
      return_format:
        'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}. type MUST be exactly one of intent_gap|spec_gap|implementation_bug|test_gap|security_risk|quality_issue|defer|reject; severity MUST be blocker|critical|high|medium|low.',
      // Bind the native reviewer identity to the exact planner-owned contract.
      // Canonical file paths alone do not change when PLAN.md bytes change.
      notes: [
        phaseBoundaryContext,
        `Plan contract SHA-256: ${planContractHash(plan)}`,
      ].join('\n\n'),
      workspace: null,
      canonical_baseline: null,
    };
    const { result: reviewRes, violation: reviewViolation } = await dispatchReadOnly(ctx, reviewTask, {
      stage: 'PLAN_REVIEW',
      authorProfiles: ['product-manager', 'system-architect'],
    });
    planReviewEnvelope = reviewRes;
    if (reviewViolation.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: plan reviewer (read-only) modified the checkout.`, reviewViolation);
    }
    // An ATTEMPT failure (ok:false — e.g. an intermittent headless read-only
    // glitch) is RECOVERABLE: re-run the plan/review cycle within the
    // plan_revisions budget rather than abandoning the phase on a transient blip.
    if (!reviewRes.ok) {
      discardDecisionProposals(ctx, reviewRes);
      if (isWorkflowCancellation(reviewRes) || revisions >= config.limits.plan_revisions) {
        return blocked(ctx, `Phase ${phase.id}: plan review failed to produce a verdict after ${revisions} revisions.`, [reviewRes.summary]);
      }
      revisions++;
      reviewNotes = [`The previous review returned no usable verdict (${reviewRes.summary.slice(0, 200)}).`];
      persistPlanCycle('PLAN');
      plan = null;
      continue;
    }
    const review = ReviewPayloadSchema.safeParse(reviewRes.payload);
    // A high-impact finding requires a correction even when the reviewer also
    // sets approved=true. This keeps the structured findings authoritative and
    // prevents a contradictory verdict from bypassing the bounded review loop.
    // Medium and low observations remain non-blocking. A completed but
    // unparseable verdict is treated as "revise" (never silent approval).
    const blockingFindings = review.success
      ? review.data.findings.filter((f) => ['blocker', 'critical', 'high'].includes(f.severity))
      : [];
    if (review.success && blockingFindings.length === 0) break;
    if (revisions >= config.limits.plan_revisions) {
      return blocked(
        ctx,
        `Phase ${phase.id}: plan not approved after ${config.limits.plan_revisions} revisions.`,
        review.success ? blockingFindings.map((f) => `${f.type}/${f.severity}: ${f.description}`) : [reviewRes.summary],
      );
    }
    revisions++;
    discardDecisionProposals(ctx, reviewRes);
    if (planEnvelope) discardDecisionProposals(ctx, planEnvelope);
    planEnvelope = null;
    planReviewEnvelope = null;
    reviewNotes = review.success
      ? blockingFindings.map((f) => `${f.type}/${f.severity}: ${f.description}`)
      : [`Reviewer verdict (unstructured): ${reviewRes.summary}`];
    persistPlanCycle('PLAN');
    plan = null;
  }
  if (!plan.approved_plan) {
    plan = PhasePlanSchema.parse({
      ...plan,
      approved_plan: {
        schema_version: 1,
        plan_contract_hash: planContractHash(plan),
        approved_at: now().toISOString(),
      },
    });
    writePlan(pp.plan, plan, `Generated for ${phase.name}.`);
    touchManifest(paths, () => {}, now);
  }
  persistPlanCycle('APPROVED', []);
  const portableApproval = plan.approved_plan;
  if (!portableApproval) throw new Error(`Phase ${phase.id}: approved plan provenance was not persisted.`);
  writeJsonAtomic(
    approvalTarget,
    PlanApprovalSchema.parse({
      schema_version: 1,
      milestone: milestone.id,
      phase: phase.id,
      plan_contract_hash: planContractHash(plan),
      approved_at: portableApproval.approved_at,
    }),
  );
  if (planEnvelope) commitDecisionProposals(ctx, planEnvelope);
  if (planReviewEnvelope) commitDecisionProposals(ctx, planReviewEnvelope);
  bus.emit('run.plan_approved', { message: 'Plan approved.' });

  // Baseline snapshot of the working tree (excluding .rijo internals) taken
  // before any worker patch is applied — the reviewer's diff and the phase
  // commit are computed against this.
  const recoveryBaselinePath = phaseRecoveryBaselinePath(ctx, milestone.id, phase.id);
  const taskStates = readPlan(pp.plan).tasks.map((task) => task.status);
  const hasAppliedTaskProgress = taskStates.some((status) =>
    ['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(status),
  );
  // Keep the first durable source baseline until the phase finalizes. Task
  // projections can temporarily return to PENDING during native recovery.
  // Replacing the baseline in that state can misclassify verified worker
  // output as a pre-existing user change and leave it outside the phase commit.
  const recoveredBaseline = readPhaseExecutionBaseline(recoveryBaselinePath);
  if (hasAppliedTaskProgress && !recoveredBaseline) {
    return blocked(ctx, `Phase ${phase.id}: source baseline needed for safe recovery is missing.`, [
      'Implemented task paths are present, but RIJO cannot prove which dirty bytes came from its isolated workers.',
      'The checkout was left unchanged; restore the phase runtime baseline or reconcile the source changes explicitly.',
    ]);
  }
  const phaseBaseline: FileSnapshot = recoveredBaseline?.snapshot ?? snapshotFiles(ctx.projectRoot);
  const dirtyAtStart = recoveredBaseline?.dirtyAtStart ?? initialDirtyAtStart;
  let controlledSnapshot = recoveredBaseline?.controlledSnapshot ?? new Map(phaseBaseline);
  const checkpointTaskPatches = (patches: PendingTaskPatch[]): WorkflowOutcome | null => {
    for (const patch of patches) {
      if (!patch.final_state_matches) {
        return blocked(ctx, `Phase ${phase.id}: committed task patch ${patch.transaction_id} no longer matches its verified bytes.`, [
          'RIJO did not overwrite or appropriate the conflicting path state.',
        ]);
      }
      for (const update of patch.controlled_updates) {
        if (update.path === '.rijo' || update.path.startsWith('.rijo/')) continue;
        if (update.state.kind === 'file') {
          controlledSnapshot.set(update.path, update.state.sha256);
        } else {
          controlledSnapshot.delete(update.path);
        }
      }
    }
    writePhaseRecoveryBaseline(
      recoveryBaselinePath,
      phaseBaseline,
      dirtyAtStart,
      controlledSnapshot,
    );
    for (const patch of patches) completeRetainedTaskPatch(paths, patch.transaction_id);
    return null;
  };
  const recoveredTaskPatches = listPendingTaskPatches(paths).filter(
    (patch) => patch.milestone === milestone.id && patch.phase === phase.id,
  );
  if (recoveredTaskPatches.length > 0) {
    if (!recoveredBaseline) {
      return blocked(ctx, `Phase ${phase.id}: source baseline needed for committed task patch recovery is missing.`, [
        'RIJO kept the task patch receipt and did not claim the changed source as a new baseline.',
      ]);
    }
    const invalidPatch = recoveredTaskPatches.find((patch) => !patch.final_state_matches);
    if (invalidPatch) {
      return blocked(ctx, `Phase ${phase.id}: committed task patch ${invalidPatch.transaction_id} no longer matches its verified bytes.`, [
        'RIJO left the task projection unchanged and did not overwrite the conflicting path state.',
      ]);
    }
    for (const patch of recoveredTaskPatches) {
      const task = readPlan(pp.plan).tasks.find((candidate) => candidate.id === patch.task);
      if (!task) {
        const repair = readPhaseRepairReceipt(pp);
        if (!repair || repair.phase !== phase.id || repair.task.id !== patch.task) {
          return blocked(ctx, `Phase ${phase.id}: retained task patch references unknown task ${patch.task}.`, []);
        }
        if (patch.controlled_updates.length === 0) {
          return blocked(ctx, `Phase ${phase.id}: retained repair patch ${patch.transaction_id} has no source change.`, [
            'RIJO did not advance the repair receipt.',
          ]);
        }
        if (repair.status === 'PENDING') {
          persistPhaseRepairReceipt(
            ctx,
            pp,
            appliedPhaseRepairReceipt(repair, patch, now().toISOString()),
          );
        }
        continue;
      }
      if (task.status === 'RUNNING') {
        transition(task.id, 'IMPLEMENTED', 'recovered committed task patch');
      } else if (!['IMPLEMENTED', 'VERIFYING', 'VERIFIED', 'DONE'].includes(task.status)) {
        return blocked(ctx, `Phase ${phase.id}: retained task patch cannot advance task ${task.id} from ${task.status}.`, []);
      }
    }
    const recoveredCheckpoint = checkpointTaskPatches(recoveredTaskPatches);
    if (recoveredCheckpoint) return recoveredCheckpoint;
    bus.emit(
      'run.task_patch_recovered',
      { message: `Recovered ${recoveredTaskPatches.length} committed task patch(es).` },
      { transactions: recoveredTaskPatches.map((patch) => patch.transaction_id) },
    );
  }
  if (recoveredBaseline) {
    const resumeDelta = diffSnapshots(controlledSnapshot, snapshotFiles(ctx.projectRoot));
    const overlapping = resumeDelta.changed.filter((changed) =>
      plan.tasks.some((task) => pathInScope(changed, task.write_scope)),
    );
    if (overlapping.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: task paths changed after RIJO last controlled them.`, [
        `Concurrent paths: ${overlapping.join(', ')}`,
        'RIJO will not appropriate or overwrite these changes; reconcile them explicitly and retry.',
      ]);
    }
  }
  if (!recoveredBaseline) {
    writePhaseRecoveryBaseline(
      recoveryBaselinePath,
      phaseBaseline,
      dirtyAtStart,
      controlledSnapshot,
    );
  }
  const applyRepairReceipt = async (
    receipt: PhaseRepairReceipt,
  ): Promise<WorkflowOutcome | null> => {
    const repair = await runRepairAttempt(
      ctx,
      milestone.id,
      phase.id,
      pp,
      plan!,
      receipt.task,
    );
    if (typeof repair !== 'string') return repair;
    const retained = listPendingTaskPatches(paths).find(
      (patch) => patch.transaction_id === repair,
    );
    if (!retained || !retained.final_state_matches) {
      return blocked(ctx, `Phase ${phase.id}: retained repair patch ${repair} is incomplete or conflicts with the checkout.`, [
        'RIJO kept the repair transaction for deterministic recovery.',
      ]);
    }
    if (retained.controlled_updates.length === 0) {
      return blocked(ctx, `Phase ${phase.id}: repair task ${receipt.task.id} produced no source change.`, [
        'A successful repair must change at least one path in its write scope.',
      ]);
    }
    persistPhaseRepairReceipt(
      ctx,
      pp,
      appliedPhaseRepairReceipt(receipt, retained, now().toISOString()),
    );
    return checkpointTaskPatches([retained]);
  };

  // Deterministic resume: a RUNNING task from a crashed run is reset (its
  // orphan workspace was already discarded — nothing it did survived); a
  // FAILED/BLOCKED task gets a fresh attempt from a clean baseline; an
  // IMPLEMENTED/VERIFYING/VERIFIED task is re-verified, never re-implemented
  // and never silently promoted.
  {
    const current = readPlan(pp.plan);
    for (const t of current.tasks) {
      if (t.status === 'RUNNING') {
        transition(t.id, 'FAILED', 'interrupted run — attempt discarded');
        transition(t.id, 'PENDING', 'reset for a fresh attempt');
      } else if (t.status === 'FAILED' || t.status === 'BLOCKED') {
        transition(t.id, 'PENDING', 'reset for a fresh attempt');
      }
    }
  }

  // ---- EXECUTE (fresh isolated workspace per task; parallel only for disjoint scopes)
  const tddRedPath = path.join(
    paths.runtimeDir,
    'tdd-red',
    `${milestone.id}-${phase.id}.json`,
  );
  const tddRedEvidences =
    readJsonIfExists<TddRedEvidence[]>(tddRedPath) ?? [];
  const groups = parallelGroups(plan.tasks, config.limits.max_parallel_agents);
  const totalTasks = plan.tasks.length;
  for (const group of groups) {
    const statuses = new Map(readPlan(pp.plan).tasks.map((t) => [t.id, t.status]));
    const pending = group.filter((t) => statuses.get(t.id) === 'PENDING');
    if (pending.length === 0) continue;

    // All lifecycle transitions FIRST (each one touches the canonical plan),
    // THEN the workspaces are created — every attempt in the group captures
    // the same, final canonical baseline.
    for (const t of pending) transition(t.id, 'RUNNING');
    const routingFor = (t: { write_scope?: string[]; code_files?: string[] }) => {
      const scopePaths = [...(t.write_scope ?? []), ...(t.code_files ?? [])];
      return {
        stage: 'EXECUTE' as const,
        requirementTags: inferSecurityTag(scopePaths),
        paths: scopePaths,
        highRisk: inferHighRisk(scopePaths),
      };
    };
    const attempts: ReplaceableAttempt[] = [];
    const workerTasks: AgentTaskDraft[] = [];
    const tddRetries: Array<TddRedRetry | null> = [];
    for (const t of pending) {
      const taskOwnsTestPath = t.write_scope.some((scope) =>
        /(^|\/)(__tests__|tests?|spec)(\/|\.|$)|\.(test|spec)\.[^.]+$/i.test(scope),
      );
      const tddInstruction =
        t.tdd && taskOwnsTestPath
          ? 'Write the test before the implementation. The framework replays the test-only change against the pre-task checkout and requires a RED failure before it applies the implementation. Then implement the GREEN change and refactor. '
          : t.tdd
            ? 'Tests for this change are allocated to a separate task; do not edit them or any path outside this task write scope. '
            : '';
      const retry = readTddRedRetry(
        tddRedRetryPath(ctx, milestone.id, phase.id, t.id),
      );
      const workerTask: AgentTaskDraft = {
        id: `exec-${phase.id}-${t.id}`,
        role: 'worker',
        objective: `Implement task ${t.id}: ${t.name}. ${tddInstruction}Work ONLY inside your isolated workspace; do not modify files outside your write scope; if you need to, stop and request a new allocation. You MAY use the host's local file-inspection and patch/edit tools inside that workspace. If a required dependency or active phase artifact is absent from the isolated workspace, read its project-root copy as read-only context. Preserve the exact project-local RIJO devDependency and existing tooling dependencies when package.json is in scope. Write only inside the isolated workspace. Do NOT execute repository code or run verification commands, tests, npm, git, network tools, or project processes yourself; the framework runs verification after you finish. Once the code is written into your write scope, return ok:true; report ok:false ONLY if you genuinely could not implement the change (never merely because you could not run the tests).`,
        canonical_files: [ctx.paths.rules, pp.plan].filter(exists),
        code_files: t.files.map((f) => path.resolve(ctx.projectRoot, f)),
        write_scope: t.write_scope,
        acceptance_criteria: [t.evidence_expected],
        verification_commands: t.tests,
        return_format: 'JSON payload: {done: boolean, notes: string}. Also list files_written.',
        notes: retry ? tddRedCorrectionNotes(retry.reason) : '',
        workspace: null,
        canonical_baseline: null,
      };
      tddRetries.push(retry);
      workerTasks.push(workerTask);
      attempts.push(replaceableAttempt(ctx, workerTask, {}, routingFor(workerTask)));
    }

    const taskIdx = plan.tasks.findIndex((t) => t.id === pending[0]!.id) + 1;
    stage('EXECUTE', `Execute ${pending.map((t) => t.id).join('+')}.`, {});
    bus.emit('run.task_start', {
      stage: 'EXECUTE',
      task: { id: pending[0]!.id, index: taskIdx, total: totalTasks, name: pending[0]!.name },
      agent: { role: 'worker', id: attempts[0]!.attempt.task.id },
      message: pending.map((t) => t.name).join(' | '),
    });

    const discardAll = () => attempts.forEach((a) => a.attempt.workspace.discard());
    let results: ValidatedAgentEnvelope[];
    try {
      results = await dispatchBatch(
        ctx,
        attempts.map((a) => a.attempt.task),
        undefined,
        (task) => routingFor(task),
        (_task, i) => attempts[i]!.prepareReplacement,
        (_task, i) => {
          const retry = tddRetries[i];
          if (!retry) return undefined;
          const record = new TaskStore(paths).read(retry.logical_task_id);
          if (
            record?.state !== 'SUCCEEDED' ||
            record.generation !== retry.rejected_generation
          ) {
            return undefined;
          }
          return {
            reason: retry.reason,
            maxReplacements: config.supervisor.max_replacements_per_task,
          };
        },
      );
    } catch (err) {
      if (isNativeResultRequired(err)) throw err;
      discardAll();
      pending.forEach((t) => transition(t.id, 'FAILED', 'dispatch error'));
      return blocked(ctx, `Phase ${phase.id}: worker dispatch failed.`, [String((err as Error).message)]);
    }

    // Any failed result discards EVERY workspace of the group before anything
    // is applied — a failed attempt can never leave changes incorporated.
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const t = pending[i]!;
      if (!r.ok) {
        discardAll();
        pending.forEach((x) => transition(x.id, 'FAILED', `group failed at ${t.id}`));
        return blocked(ctx, `Phase ${phase.id}: task ${t.id} failed.`, [r.summary, ...r.scope_requests.map((s) => `scope request: ${s}`)]);
      }
    }

    // Canonical baseline must still be current: an attempt briefed against an
    // older canonical context can never be applied.
    const baselineNow = canonicalBaselineHash(paths);
    const stale = attempts.filter((a) => a.attempt.task.canonical_baseline !== baselineNow);
    if (stale.length > 0) {
      discardAll();
      pending.forEach((t) => transition(t.id, 'FAILED', 'canonical baseline drift'));
      return blocked(ctx, `Phase ${phase.id}: canonical context changed while attempts ran (CANONICAL_DRIFT).`, [
        `Stale attempts: ${stale.map((a) => a.attempt.task.id).join(', ')}. Re-run to retry against the current baseline.`,
      ]);
    }

    // A TDD task that owns both tests and implementation must prove RED
    // against the pre-task checkout before its implementation patch reaches
    // the controlled tree. RIJO overlays only test harness files into a fresh
    // isolated workspace. The real command must fail for a test reason.
    //
    // A protocol-valid writer result can still fail this deterministic gate.
    // Replace that result with a new fenced generation. Keep earlier groups
    // applied. Keep unrelated workspaces in this group until the corrected
    // result is available. A native helper pause discards them safely and
    // replays their exact successful results into fresh workspaces next turn.
    for (let i = 0; i < attempts.length; i++) {
      const task = pending[i]!;
      if (
        !task.tdd ||
        !task.write_scope.some(isTestPath) ||
        tddRedEvidences.some((entry) => entry.task_id === task.id)
      ) {
        continue;
      }

      const retryPath = tddRedRetryPath(ctx, milestone.id, phase.id, task.id);
      for (;;) {
        const red = runTddRedProof(ctx, phase.id, task, attempts[i]!);
        if (red.ok) {
          tddRedEvidences.push({ task_id: task.id, commands: red.commands });
          writeJsonAtomic(tddRedPath, tddRedEvidences);
          fs.rmSync(retryPath, { force: true });
          break;
        }

        const previousRetry = readTddRedRetry(retryPath);
        const replacementCount = previousRetry?.replacement_count ?? 0;
        const maxReplacements = config.supervisor.max_replacements_per_task;
        if (replacementCount >= maxReplacements) {
          discardAll();
          pending.forEach((candidate) =>
            transition(candidate.id, 'FAILED', `TDD RED replacement exhausted at ${task.id}`),
          );
          return blocked(
            ctx,
            `Phase ${phase.id}: task ${task.id} has no valid TDD RED evidence after ${replacementCount} replacement attempt(s).`,
            [red.reason],
          );
        }

        const retry = TddRedRetrySchema.parse({
          schema_version: 1,
          logical_task_id: attempts[i]!.attempt.task.id,
          task_id: task.id,
          replacement_count: replacementCount + 1,
          rejected_generation: results[i]!.generation,
          reason: red.reason,
        });
        writeJsonAtomic(retryPath, retry);

        // The rejected workspace can never be applied. Build the corrected
        // request from the original bounded draft plus durable factual notes.
        attempts[i]!.attempt.workspace.discard();
        const correctedDraft: AgentTaskDraft = {
          ...workerTasks[i]!,
          notes: tddRedCorrectionNotes(red.reason),
        };
        const corrected = replaceableAttempt(
          ctx,
          correctedDraft,
          {},
          routingFor(correctedDraft),
        );
        attempts[i] = corrected;

        let replacementResult: ValidatedAgentEnvelope;
        try {
          replacementResult = await dispatch(
            ctx,
            corrected.attempt.task,
            routingFor(corrected.attempt.task),
            {
              prepareReplacement: corrected.prepareReplacement,
              replaceAfterValidationFailure: {
                reason: red.reason,
                maxReplacements,
              },
            },
          );
        } catch (error) {
          if (isNativeResultRequired(error)) {
            throw error;
          }
          discardAll();
          pending.forEach((candidate) =>
            transition(candidate.id, 'FAILED', `TDD RED replacement dispatch failed at ${task.id}`),
          );
          return blocked(ctx, `Phase ${phase.id}: task ${task.id} replacement dispatch failed.`, [
            String((error as Error).message),
          ]);
        }
        if (!replacementResult.ok) {
          discardAll();
          pending.forEach((candidate) =>
            transition(candidate.id, 'FAILED', `TDD RED replacement failed at ${task.id}`),
          );
          return blocked(ctx, `Phase ${phase.id}: task ${task.id} replacement failed.`, [
            replacementResult.summary,
            ...replacementResult.scope_requests.map((scope) => `scope request: ${scope}`),
          ]);
        }
        results[i] = replacementResult;
      }
    }

    // Authoritative scope enforcement per INDIVIDUAL task: the real filesystem
    // delta of each workspace (including .rijo, removals, renames, symlinks) is
    // validated against that task's own scope — never the group union, and the
    // agent's files_written report is irrelevant.
    try {
      for (const a of attempts) a.attempt.workspace.validate();
    } catch (err) {
      discardAll();
      pending.forEach((t) => transition(t.id, 'FAILED', 'boundary violation'));
      if (
        err instanceof WorkspaceScopeError ||
        err instanceof CanonicalWriteError ||
        err instanceof SymlinkEscapeError
      ) {
        return blocked(ctx, `Phase ${phase.id}: ${err.message}`, []);
      }
      throw err;
    }
    const bindingIssues = attempts.flatMap((attempt) =>
      validateProjectToolingBinding(ctx.projectRoot, attempt.attempt.workspace.root),
    );
    if (bindingIssues.length > 0) {
      discardAll();
      pending.forEach((task) =>
        transition(task.id, 'FAILED', 'project tooling binding violation'),
      );
      return blocked(
        ctx,
        `Phase ${phase.id}: a worker changed the project-local RIJO tooling binding.`,
        bindingIssues,
      );
    }

    // Apply the validated patches to the controlled checkout. A conflict with a
    // concurrent (user) change blocks with no partial merge.
    const retainedPatchIds: string[] = [];
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const t = pending[i]!;
      let transactionId: string;
      try {
        const applied = a.attempt.workspace.applyVerifiedPatch({
          taskPatch: {
            milestone: milestone.id,
            phase: phase.id,
            task: t.id,
          },
        });
        transactionId = applied.transaction_id!;
      } catch (err) {
        discardAll();
        if (err instanceof TransactionApplyConflictError) {
          return blocked(ctx, `Phase ${phase.id}: ${err.message}`, [
            'The committed task patch journal remains available. Resolve the external path state, then resume.',
          ]);
        }
        transition(t.id, 'FAILED', 'patch conflict');
        if (err instanceof PatchConflictError) {
          return blocked(ctx, `Phase ${phase.id}: ${err.message}`, [
            'Commit or revert the concurrent change, then re-run.',
          ]);
        }
        throw err;
      }
      ctx.taskPatchHooks.afterApplied?.(transactionId, t.id);
      retainedPatchIds.push(transactionId);
      a.attempt.workspace.discard();
    }
    const retainedPatches = listPendingTaskPatches(paths).filter((patch) =>
      retainedPatchIds.includes(patch.transaction_id),
    );
    if (
      retainedPatches.length !== retainedPatchIds.length ||
      retainedPatches.some((patch) => !patch.final_state_matches)
    ) {
      return blocked(ctx, `Phase ${phase.id}: retained task patch receipts are incomplete or conflict with the checkout.`, [
        'RIJO left every task projection unchanged. The retained journals remain available for safe recovery.',
      ]);
    }
    for (const t of pending) {
      transition(t.id, 'IMPLEMENTED');
      bus.emit('run.task_done', {
        completedUnits: readPlan(pp.plan).tasks.filter((x) => x.status !== 'PENDING' && x.status !== 'RUNNING').length,
        totalUnits: totalTasks,
        message: `Task ${t.id} is implemented but not verified.`,
      });
    }
    for (const result of results) commitDecisionProposals(ctx, result);
    const taskPatchCheckpoint = checkpointTaskPatches(retainedPatches);
    if (taskPatchCheckpoint) return taskPatchCheckpoint;
  }

  // ---- Evidence gate: a phase MUST produce real command evidence. A task may
  // contribute zero commands only if it carries an explicit, auditable
  // no_execution_justification (e.g. a pure docs edit). Otherwise the phase is
  // BLOCKED rather than silently passing with zero verifications.
  const projectCommands = detectProjectCommands(ctx);
  const tasksNeedingEvidence = plan.tasks.filter((t) => !t.no_execution_justification);
  const anyTaskHasTests = plan.tasks.some((t) => t.tests.length > 0);
  if (!anyTaskHasTests && projectCommands.length === 0 && tasksNeedingEvidence.length > 0) {
    return blocked(
      ctx,
      `Phase ${phase.id}: NO_VERIFICATION_EVIDENCE — no verification command available for tasks ${tasksNeedingEvidence
        .map((t) => t.id)
        .join(', ')}.`,
      [
        'Declare tests on each task, add a project verification script, or set an explicit no_execution_justification for genuinely non-executable work.',
      ],
    );
  }

  // ---- VERIFY + CODE_REVIEW loop (bounded)
  let reviewLoops = 0;
  let evidences: CommandEvidence[] = [];
  let acceptedReviewInputHash: string | null = null;
  const legacyRepair = readPhaseRepairReceipt(pp)
    ? null
    : recoverLegacyPendingReviewRepair(ctx, pp, phase.id, plan);
  if (legacyRepair) persistPhaseRepairReceipt(ctx, pp, legacyRepair);
  const resumedRepair = readPhaseRepairReceipt(pp);
  if (resumedRepair) {
    reviewLoops = resumedRepair.loop;
    if (resumedRepair.status === 'PENDING') {
      const repairOutcome = await applyRepairReceipt(resumedRepair);
      if (repairOutcome) return repairOutcome;
    } else {
      const repairIssues = validateAppliedRepairReceipt(
        resumedRepair,
        ctx.projectRoot,
        controlledSnapshot,
        snapshotFiles(ctx.projectRoot),
      );
      if (repairIssues.length > 0) {
        return blocked(
          ctx,
          `Phase ${phase.id}: the applied repair receipt does not match the controlled checkout.`,
          repairIssues,
        );
      }
    }
  }
  while (true) {
    stage('VERIFY', 'Run build, lint, and focused tests.');
    for (const t of readPlan(pp.plan).tasks) {
      if (t.status === 'IMPLEMENTED' || t.status === 'VERIFIED') transition(t.id, 'VERIFYING');
    }
    evidences = [
      ...prepareProjectDependencies(ctx, phaseBaseline, projectCommands),
      ...runVerification(ctx, plan, projectCommands),
    ];

    // A command rejected by the security policy is a hard block, never a
    // repairable failure — we do not loop a worker on a forbidden command.
    const policyBlocked = evidences.filter((e) => e.blocked);
    if (policyBlocked.length > 0) {
      return blocked(
        ctx,
        `Phase ${phase.id}: verification command blocked by security policy.`,
        policyBlocked.map((e) => `${e.command} → ${e.summary}`),
      );
    }

    // Enforce the evidence gate at runtime too: if nothing actually ran and
    // some task required evidence, block.
    if (evidences.length === 0 && tasksNeedingEvidence.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: NO_VERIFICATION_EVIDENCE — zero commands executed.`, [
        'Every task without a no_execution_justification must produce at least one verification command.',
      ]);
    }

    const failures = evidences.filter((e) => e.exit_code !== 0);
    if (failures.length > 0) {
      if (reviewLoops >= config.limits.qa_fix_loops) {
        return blocked(
          ctx,
          `Phase ${phase.id}: verification still failing after ${reviewLoops} repair attempts.`,
          failures.map((f) => `${f.command} → exit ${f.exit_code}\n${f.summary.slice(0, 400)}`),
        );
      }
      reviewLoops++;
      const receipt = PhaseRepairReceiptSchema.parse({
        version: 1,
        phase: phase.id,
        kind: 'verification',
        loop: reviewLoops,
        status: 'PENDING',
        task: {
          id: `verify-fix-${phase.id}-l${reviewLoops}`,
          objective: 'Fix the verification failures below with the smallest coherent change. Do not weaken tests to make them pass.',
          acceptance: ['All verification commands exit 0'],
          commands: failures.map((f) => f.command),
          notes: failures.map((f) => `${f.command} → exit ${f.exit_code}\n${f.summary.slice(0, 800)}`).join('\n\n'),
        },
        created_at: now().toISOString(),
        controlled_updates: readPhaseRepairReceipt(pp)?.controlled_updates ?? [],
      });
      persistPhaseRepairReceipt(ctx, pp, receipt);
      const repairOutcome = await applyRepairReceipt(receipt);
      if (repairOutcome) return repairOutcome;
      continue;
    }

    for (const t of readPlan(pp.plan).tasks) {
      if (t.status === 'VERIFYING') {
        transition(t.id, 'VERIFIED');
        await durableCheckpoint(ctx, `task:${phase.id}:${t.id}:verified`, {
          commit: ctx.git.headCommit(ctx.projectRoot),
        });
      }
    }

    stage('CODE_REVIEW', 'Run an independent code review.');
    const diffSummary = changedFilesReport(ctx, phaseBaseline);
    const changeFingerprint = phaseChangeFingerprint(ctx, phaseBaseline);
    const reviewedPaths = plan.tasks.flatMap((t) => [...t.files, ...t.write_scope]);
    const securityContext = [
      phase.name,
      ...reqDoc.requirements
        .filter((requirement) => requirement.phase === phase.id)
        .flatMap((requirement) => [requirement.description, requirement.acceptance]),
      ...reviewedPaths,
    ].join('\n');
    const reviewInputHash = phaseReviewInputHash(
      phase.id,
      plan,
      changeFingerprint,
      evidences,
      securityContext,
    );
    const acceptedGate = readAcceptedReviewGate(pp, reviewInputHash);
    if (acceptedGate) {
      commitDecisionDispatchReceipts(ctx, acceptedGate.decisionDispatches);
      reviewLoops = acceptedGate.loop;
      acceptedReviewInputHash = reviewInputHash;
      break;
    }
    const crTask: AgentTaskDraft = {
      id: `code-review-${phase.id}-l${reviewLoops}`,
      role: 'reviewer',
      objective:
        'Independent code review. You receive the plan, the diff and the verification evidence — never the implementer reasoning. RIJO runs framework-owned UI smoke after this review. Do not reject only because that future smoke evidence is absent. Check whether the requested smoke journey can prove the UI acceptance criteria. Classify each finding as intent_gap, spec_gap, implementation_bug, test_gap, security_risk, quality_issue, defer or reject.',
      canonical_files: [pp.plan].filter(exists),
      code_files: plan.tasks.flatMap((t) => t.files.map((f) => path.resolve(ctx.projectRoot, f))),
      write_scope: [],
      acceptance_criteria: [],
      verification_commands: [],
      return_format: 'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}',
      notes:
        `CHANGE SET HASH: ${changeFingerprint}\n\n` +
        `DIFF SUMMARY:\n${diffSummary}\n\nEVIDENCE:\n${evidences.map((e) => `${e.command} → exit ${e.exit_code}`).join('\n')}`,
      workspace: null,
      canonical_baseline: null,
    };
    const { result: crRes, violation: crViolation } = await dispatchReadOnly(ctx, crTask, {
      stage: 'CODE_REVIEW',
      requirementTags: inferSecurityTag(reviewedPaths),
      authorProfiles: ['senior-software-engineer'],
    });
    if (crViolation.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: code reviewer (read-only) modified the checkout.`, crViolation);
    }
    // An ATTEMPT failure (ok:false — e.g. an intermittent headless read-only
    // glitch) is RECOVERABLE: the code is already implemented and verified, so
    // simply re-run the verify+review cycle within the review_loops budget
    // rather than discarding a green phase on a transient review blip.
    // A COMPLETED review whose verdict is not in schema is NOT auto-approval
    // (that would silently drop the gate): treat it as an unresolved review with
    // the reviewer's summary as the finding, and run the bounded repair loop
    // below — it only blocks once the review_loops budget is exhausted.
    if (!crRes.ok) {
      discardDecisionProposals(ctx, crRes);
      if (isWorkflowCancellation(crRes) || reviewLoops >= config.limits.review_loops) {
        return blocked(ctx, `Phase ${phase.id}: code review failed to produce a verdict after ${config.limits.review_loops} cycles.`, [crRes.summary]);
      }
      reviewLoops++;
      continue;
    }
    const cr = ReviewPayloadSchema.safeParse(crRes.payload);
    if (!cr.success) {
      discardDecisionProposals(ctx, crRes);
      if (reviewLoops >= config.limits.review_loops) {
        return blocked(ctx, `Phase ${phase.id}: code review produced no usable verdict after ${config.limits.review_loops} cycles.`, [crRes.summary]);
      }
      reviewLoops++;
      const receipt = PhaseRepairReceiptSchema.parse({
        version: 1,
        phase: phase.id,
        kind: 'review',
        loop: reviewLoops,
        status: 'PENDING',
        task: {
          id: `review-fix-${phase.id}-l${reviewLoops}`,
          objective: 'Address the reviewer feedback below with minimal coherent changes; keep all verification commands passing.',
          acceptance: ['Reviewer feedback addressed', 'Verification commands still pass'],
          commands: [],
          notes: `Reviewer verdict (unstructured): ${crRes.summary}`,
        },
        created_at: now().toISOString(),
        controlled_updates: readPhaseRepairReceipt(pp)?.controlled_updates ?? [],
      });
      persistPhaseRepairReceipt(ctx, pp, receipt);
      const repairOutcome = await applyRepairReceipt(receipt);
      if (repairOutcome) return repairOutcome;
      continue;
    }
    let reviewData = cr.data;
    let securityEnvelope: ValidatedAgentEnvelope | null = null;
    if (
      /\b(auth(?:entication|orization)?|permission|payment|money|secret|credential|upload|delete|destruct|trust boundary|personal data)\b/i.test(
        securityContext,
      )
    ) {
      stage('ENGINEERING_REVIEW', 'Run the risk-triggered security review.');
      const securityTask: AgentTaskDraft = {
        id: `security-review-${phase.id}-l${reviewLoops}`,
        role: 'reviewer',
        objective:
          'Review only the changed high-risk surface. Check authorization, trust boundaries, secret handling, destructive actions, upload validation, money movement, and data integrity as applicable. Return only evidence-backed findings. Do not change files.',
        canonical_files: [pp.plan].filter(exists),
        code_files: plan.tasks.flatMap((task) =>
          task.files.map((file) => path.resolve(ctx.projectRoot, file)),
        ),
        write_scope: [],
        acceptance_criteria: ['Every applicable high-risk boundary is reviewed.'],
        verification_commands: [],
        return_format:
          'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}.',
        notes:
          `CHANGE SET HASH: ${changeFingerprint}\n\n` +
          `RISK CONTEXT:\n${securityContext}\n\nDIFF SUMMARY:\n${diffSummary}`,
      };
      const securityReview = await dispatchReadOnly(ctx, securityTask, {
        stage: 'ENGINEERING_REVIEW',
        requirementTags: ['security'],
      });
      securityEnvelope = securityReview.result;
      const securityPayload = ReviewPayloadSchema.safeParse(securityReview.result.payload);
      if (
        securityReview.violation.length > 0 ||
        !securityReview.result.ok ||
        !securityPayload.success
      ) {
        discardDecisionProposals(ctx, securityReview.result);
        discardDecisionProposals(ctx, crRes);
        if (reviewLoops >= config.limits.review_loops) {
          return blocked(
            ctx,
            `Phase ${phase.id}: the required security review did not produce a valid verdict.`,
            securityReview.violation.length > 0
              ? securityReview.violation
              : [securityReview.result.summary],
          );
        }
        reviewLoops++;
        continue;
      }
      reviewData = {
        approved: reviewData.approved && securityPayload.data.approved,
        findings: [...reviewData.findings, ...securityPayload.data.findings],
      };
    }
    const blockingSeverities = new Set(['blocker', 'critical', 'high']);
    const contractGaps = reviewData.findings.filter(
      (f) => (f.type === 'intent_gap' || f.type === 'spec_gap') && blockingSeverities.has(f.severity),
    );
    if (contractGaps.length > 0) {
      persistReviewDoc(ctx, pp, reviewData, reviewLoops);
      return blocked(
        ctx,
        `Phase ${phase.id}: review found plan/intent gaps; returning to planning instead of patching locally.`,
        contractGaps.map((f) => `${f.type}: ${f.description}`),
      );
    }
    // Medium/low review observations are recorded in REVIEW.md, but cannot
    // overturn green executable evidence or manufacture a technical blocker.
    // This is the operational form of the autonomous-decision policy: only a
    // high-impact finding enters the bounded repair/block path.
    const actionable = reviewData.findings.filter(
      (f) => !['defer', 'reject'].includes(f.type) && blockingSeverities.has(f.severity),
    );
    if (actionable.length === 0) {
      const decisionReceipts = decisionDispatchReceipts([crRes, securityEnvelope]);
      persistReviewDoc(
        ctx,
        pp,
        reviewData,
        reviewLoops,
        reviewInputHash,
        decisionReceipts,
      );
      acceptedReviewInputHash = reviewInputHash;
      ctx.phaseGateHooks.afterAcceptedReview?.();
      commitDecisionProposals(ctx, crRes);
      if (securityEnvelope) commitDecisionProposals(ctx, securityEnvelope);
      break;
    }
    if (reviewLoops >= config.limits.review_loops) {
      persistReviewDoc(ctx, pp, reviewData, reviewLoops);
      return blocked(
        ctx,
        `Phase ${phase.id}: review findings persist after ${config.limits.review_loops} repair cycles.`,
        actionable.map((f) => `${f.type}/${f.severity}: ${f.description}`),
      );
    }
    persistReviewDoc(ctx, pp, reviewData, reviewLoops);
    reviewLoops++;
    discardDecisionProposals(ctx, crRes);
    if (securityEnvelope) discardDecisionProposals(ctx, securityEnvelope);
    const receipt = PhaseRepairReceiptSchema.parse({
      version: 1,
      phase: phase.id,
      kind: 'review',
      loop: reviewLoops,
      status: 'PENDING',
      task: {
        id: `review-fix-${phase.id}-l${reviewLoops}`,
        objective: 'Address the valid review findings below with minimal coherent changes.',
        acceptance: ['Findings addressed', 'Verification commands still pass'],
        commands: [],
        notes: actionable.map((f) => `${f.type}/${f.severity}: ${f.description}${f.file ? ` (${f.file})` : ''}`).join('\n'),
      },
      created_at: now().toISOString(),
      controlled_updates: readPhaseRepairReceipt(pp)?.controlled_updates ?? [],
    });
    persistPhaseRepairReceipt(ctx, pp, receipt);
    const repairOutcome = await applyRepairReceipt(receipt);
    if (repairOutcome) return repairOutcome;
  }

  if (!acceptedReviewInputHash) {
    return blocked(ctx, `Phase ${phase.id}: the accepted engineering review was not retained.`);
  }

  // ---- UI_SMOKE (only for UI surfaces; honest about capability)
  let uiSmokeNote = 'not applicable (no UI surface in this phase)';
  if (phase.ui_surface) {
    if (!ctx.runner.capabilities.browser) {
      uiSmokeNote = 'SKIPPED: browser capability unavailable in this runtime (recorded, not simulated)';
      bus.emit('run.ui_smoke', { stage: 'UI_SMOKE', message: 'The browser is unavailable. Record the smoke test as not executed.' });
    } else {
      stage('UI_SMOKE', 'Run a visual smoke test on the changed surface.');
      const screenshotScope = path.relative(ctx.projectRoot, path.join(milestone.paths.qaDir, 'screenshots')).split(path.sep).join('/') + '/**';
      const smokeInputHash = phaseUiSmokeInputHash(
        phase.id,
        plan,
        phaseChangeFingerprint(ctx, phaseBaseline),
        acceptedReviewInputHash,
      );
      const priorSmoke = readUiSmokeReceipt(ctx, pp, smokeInputHash, screenshotScope);
      if (priorSmoke) {
        commitDecisionDispatchReceipts(ctx, priorSmoke.decisionDispatches);
        uiSmokeNote = smokeNote(priorSmoke.result);
      } else {
        const smokeTask: AgentTaskDraft = {
          id: `ui-smoke-${phase.id}`,
          role: 'qa',
          objective:
            'UI smoke: load the changed surface, check console and network for errors, exercise the main navigation, capture a minimal screenshot.',
          canonical_files: [pp.plan].filter(exists),
          code_files: [],
          write_scope: [screenshotScope],
          acceptance_criteria: [
            'No unhandled console errors',
            'No failing network requests on the main flow',
          ],
          verification_commands: [],
          return_format:
            'JSON payload: {passed, console_errors[], network_errors[], screenshot, notes}',
          notes: '',
          workspace: null,
          canonical_baseline: null,
        };
        const smokeHandle = replaceableAttempt(
          ctx,
          smokeTask,
          { canonicalWriteScope: [screenshotScope] },
          { stage: 'UI_SMOKE' },
        );
        const smokeRes = await dispatch(
          ctx,
          smokeHandle.attempt.task,
          { stage: 'UI_SMOKE' },
          { prepareReplacement: smokeHandle.prepareReplacement },
        );
        const smoke = UiSmokePayloadSchema.safeParse(smokeRes.payload);
        try {
          if (!smokeRes.ok || !smoke.success || !smoke.data.passed) {
            return blocked(ctx, `Phase ${phase.id}: UI smoke failed.`, [
              smokeRes.summary,
              ...(smoke.success
                ? [...smoke.data.console_errors, ...smoke.data.network_errors]
                : []),
            ]);
          }
          smokeHandle.attempt.workspace.applyVerifiedPatch();
          const decisionReceipts = decisionDispatchReceipts([smokeRes]);
          writeUiSmokeReceipt(
            ctx,
            pp,
            smokeInputHash,
            smoke.data,
            decisionReceipts,
            screenshotScope,
          );
        } catch (err) {
          return blocked(ctx, `Phase ${phase.id}: UI smoke violated workspace boundaries.`, [
            String((err as Error).message),
          ]);
        } finally {
          smokeHandle.attempt.workspace.discard();
        }
        ctx.phaseGateHooks.afterUiSmokeReceipt?.();
        commitDecisionProposals(ctx, smokeRes);
        uiSmokeNote = smokeNote(smoke.data);
      }
    }
  }

  // ---- PERSIST + FINALIZE: transactional, resumable phase finalization (P0.7).
  // Verification and review have passed. A durable FINALIZING marker now guards
  // the requirement/roadmap/checkpoint DONE flips and the two-commit-plus-seal
  // sequence (C1 = code + phase state without self-reference; C2 = evidence
  // pointing at C1; seal), so a crash between any two steps is always observable
  // as a clean pre-finalization state (retryable) or a fully DONE-and-committed
  // phase — never a DONE phase without its commits. See workflows/finalize.ts;
  // an interrupted finalization is resumed under the lock by reconcileFinalization.
  stage('PERSIST', 'Persist the summary, evidence, and state.');
  const finalization = await stageFinalization(ctx, {
    milestone,
    phase,
    pp,
    plan,
    evidences,
    tddRedEvidences,
    uiSmokeNote,
    phaseBaseline,
    dirtyAtStart,
  });
  if (finalization.ok) fs.rmSync(recoveryBaselinePath, { force: true });
  return finalization;
}

/**
 * Run a repair worker in an isolated workspace and apply its verified patch.
 * Returns a WorkflowOutcome on failure (to be returned by the caller), null on
 * success.
 */
async function runRepairAttempt(
  ctx: WorkflowContext,
  milestoneId: string,
  phaseId: string,
  pp: PhasePaths,
  plan: PhasePlan,
  spec: RepairSpec,
): Promise<WorkflowOutcome | string> {
  const repairTask = repairTaskDraft(ctx, pp, plan, spec);
  const handle = replaceableAttempt(ctx, repairTask, {}, { stage: 'EXECUTE' });
  let preserveNativeWorkspace = false;
  try {
    const res = await dispatch(ctx, handle.attempt.task, { stage: 'EXECUTE' }, { prepareReplacement: handle.prepareReplacement });
    if (!res.ok) {
      return blocked(ctx, `Phase ${phaseId}: repair worker failed.`, [res.summary]);
    }
    handle.attempt.workspace.validate();
    const bindingIssues = validateProjectToolingBinding(
      ctx.projectRoot,
      handle.attempt.workspace.root,
    );
    if (bindingIssues.length > 0) {
      return blocked(
        ctx,
        `Phase ${phaseId}: a repair worker changed the project-local RIJO tooling binding.`,
        bindingIssues,
      );
    }
    const applied = handle.attempt.workspace.applyVerifiedPatch({
      taskPatch: {
        milestone: milestoneId,
        phase: phaseId,
        task: spec.id,
      },
    });
    commitDecisionProposals(ctx, res);
    if (!applied.transaction_id) {
      throw new Error(`Phase ${phaseId}: repair patch did not retain a transaction receipt.`);
    }
    ctx.taskPatchHooks.afterApplied?.(applied.transaction_id, spec.id);
    return applied.transaction_id;
  } catch (err) {
    if (isNativeResultRequired(err)) {
      preserveNativeWorkspace = true;
      throw err;
    }
    if (
      err instanceof WorkspaceScopeError ||
      err instanceof CanonicalWriteError ||
      err instanceof SymlinkEscapeError ||
      err instanceof PatchConflictError
    ) {
      return blocked(ctx, `Phase ${phaseId}: repair attempt discarded — ${err.message}`, []);
    }
    throw err;
  } finally {
    if (!preserveNativeWorkspace) handle.attempt.workspace.discard();
  }
}

/** Detect the project's own verification scripts (npm scripts today). */
function detectProjectCommands(ctx: WorkflowContext): string[] {
  const commands: string[] = [];
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
      for (const s of ['typecheck', 'lint', 'build', 'test']) {
        if (pkg.scripts?.[s]) commands.push(`npm run ${s}`);
      }
    } catch {
      /* unparseable package.json — plan tests only */
    }
  }
  return commands;
}

function runTddRedProof(
  ctx: WorkflowContext,
  phaseId: string,
  task: PhasePlan['tasks'][number],
  implementationAttempt: ReplaceableAttempt,
): { ok: true; commands: CommandEvidence[] } | { ok: false; reason: string } {
  if (task.tests.length === 0) {
    return { ok: false, reason: 'The TDD task has no executable test command.' };
  }
  const delta = implementationAttempt.attempt.workspace.collectDelta();
  const harnessFiles = delta.changed.filter(
    (relativePath) =>
      isTestHarnessPath(relativePath) &&
      task.write_scope.some((scope) => pathInScope(relativePath, [scope])),
  );
  if (!harnessFiles.some(isTestPath)) {
    return {
      ok: false,
      reason: 'The task did not add or change a test file inside its write scope.',
    };
  }

  const redWorkspace = AttemptWorkspace.create(ctx.projectRoot, {
    taskId: `tdd-red-${phaseId}-${task.id}`,
    writeScope: harnessFiles,
    baselineCommit: ctx.git.headCommit(ctx.projectRoot),
    baselineCanonicalHash: canonicalBaselineHash(ctx.paths),
  });
  try {
    for (const relativePath of harnessFiles) {
      const source = path.join(implementationAttempt.attempt.workspace.root, relativePath);
      const target = path.join(redWorkspace.root, relativePath);
      if (!exists(source)) {
        fs.rmSync(target, { force: true });
        continue;
      }
      ensureDir(path.dirname(target));
      fs.copyFileSync(source, target);
    }
    redWorkspace.validate();

    const packageFile = path.join(redWorkspace.root, 'package.json');
    if (harnessFiles.includes('package.json') && exists(packageFile)) {
      try {
        const pkg = JSON.parse(readText(packageFile)) as {
          dependencies?: Record<string, unknown>;
          devDependencies?: Record<string, unknown>;
          optionalDependencies?: Record<string, unknown>;
        };
        const dependencyCount =
          Object.keys(pkg.dependencies ?? {}).length +
          Object.keys(pkg.devDependencies ?? {}).length +
          Object.keys(pkg.optionalDependencies ?? {}).length;
        if (dependencyCount > 0) {
          const install = ctx.shell.run('npm install --no-audit --no-fund', {
            cwd: redWorkspace.root,
            allowInstall: true,
            timeoutMs: 10 * 60 * 1000,
          });
          if (install.exit_code !== 0) {
            return {
              ok: false,
              reason: `The RED workspace dependency setup failed: ${install.summary.slice(0, 400)}`,
            };
          }
        }
      } catch (error) {
        return {
          ok: false,
          reason: `The RED workspace package.json is invalid: ${String(error)}`,
        };
      }
    }

    const commands = task.tests.map((command) =>
      ctx.shell.run(command, { cwd: redWorkspace.root }),
    );
    const blockedCommand = commands.find((command) => command.blocked);
    if (blockedCommand) {
      return {
        ok: false,
        reason: `The RED command was blocked: ${blockedCommand.command} → ${blockedCommand.summary}`,
      };
    }
    const infrastructureFailure = commands.find(
      (command) =>
        command.exit_code !== 0 &&
        /(ENOENT|command not found|missing script|could not determine executable|cannot find package|module not found)/i.test(
          command.summary,
        ),
    );
    if (infrastructureFailure) {
      return {
        ok: false,
        reason: `The RED command failed because the test environment was incomplete: ${infrastructureFailure.summary.slice(0, 400)}`,
      };
    }
    if (!commands.some((command) => command.exit_code !== 0)) {
      return {
        ok: false,
        reason: 'All RED commands passed against the pre-task checkout. The new tests do not prove the behavior change.',
      };
    }
    ctx.bus.emit(
      'run.tdd_red',
      {
        stage: 'EXECUTE',
        message: `Task ${task.id} produced a failing RED test before implementation.`,
      },
      {
        task: task.id,
        commands: commands.map((command) => ({
          command: command.command,
          exit: command.exit_code,
        })),
      },
    );
    return { ok: true, commands };
  } finally {
    redWorkspace.discard();
  }
}

/**
 * Install newly declared Node.js dependencies through the managed command
 * gate before project scripts run. The command policy disables lifecycle
 * scripts and enables network access only for this explicit installation.
 */
function prepareProjectDependencies(
  ctx: WorkflowContext,
  phaseBaseline: FileSnapshot,
  projectCommands: string[],
): CommandEvidence[] {
  if (!projectCommands.some((command) => command.startsWith('npm run '))) return [];
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (!exists(pkgPath)) return [];

  const delta = diffSnapshots(phaseBaseline, snapshotFiles(ctx.projectRoot));
  const nodeModulesPath = path.join(ctx.projectRoot, 'node_modules');
  if (!delta.changed.includes('package.json') && exists(nodeModulesPath)) return [];

  let packageCount = 0;
  try {
    const pkg = JSON.parse(readText(pkgPath)) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    packageCount =
      Object.keys(pkg.dependencies ?? {}).length +
      Object.keys(pkg.devDependencies ?? {}).length +
      Object.keys(pkg.optionalDependencies ?? {}).length;
  } catch {
    return [];
  }
  if (packageCount === 0) return [];

  const command = 'npm install --no-audit --no-fund';
  const evidence = ctx.shell.run(command, {
    cwd: ctx.projectRoot,
    allowInstall: true,
    timeoutMs: 10 * 60 * 1000,
  });
  ctx.bus.emit(
    'run.verify_command',
    { message: `${command} → exit ${evidence.exit_code}` },
    { command, exit: evidence.exit_code, managed_install: true },
  );
  return [evidence];
}

function runVerification(ctx: WorkflowContext, plan: PhasePlan, projectCommands: string[]): CommandEvidence[] {
  const commands = new Set<string>(projectCommands);
  for (const t of plan.tasks) for (const test of t.tests) commands.add(test);
  const evidences: CommandEvidence[] = [];
  for (const cmd of commands) {
    const ev = ctx.shell.run(cmd, { cwd: ctx.projectRoot });
    evidences.push(ev);
    ctx.bus.emit('run.verify_command', { message: `${cmd} → exit ${ev.exit_code}` }, { command: cmd, exit: ev.exit_code });
  }
  return evidences;
}

/**
 * Give the reviewer the REAL change set: for every path changed since the phase
 * baseline, include the file's current (redacted, truncated) content. This is
 * the actual patch the reviewer needs — not a bare list of file names.
 */
function changedFilesReport(ctx: WorkflowContext, baseline: FileSnapshot): string {
  const delta = diffSnapshots(baseline, snapshotFiles(ctx.projectRoot));
  if (delta.changed.length === 0) return 'no source changes detected';
  const parts: string[] = [];
  for (const rel of delta.changed.slice(0, 40)) {
    if (delta.removed.includes(rel)) {
      parts.push(`--- removed: ${rel}`);
      continue;
    }
    const content = readTextIfExists(path.join(ctx.projectRoot, rel)) ?? '';
    const shown = content.length > 4000 ? `${content.slice(0, 4000)}\n…(truncated)` : content;
    parts.push(`--- ${delta.added.includes(rel) ? 'added' : 'modified'}: ${rel}\n${redact(shown)}`);
  }
  if (delta.changed.length > 40) parts.push(`…and ${delta.changed.length - 40} more changed files`);
  return parts.join('\n\n');
}

function phaseReviewInputHash(
  phaseId: string,
  plan: PhasePlan,
  changeFingerprint: string,
  evidences: CommandEvidence[],
  securityContext: string,
): string {
  return sha256(JSON.stringify({
    phase: phaseId,
    plan_contract_hash: planContractHash(plan),
    change_fingerprint: changeFingerprint,
    evidence: evidences.map((evidence) => ({
      command: evidence.command,
      exit_code: evidence.exit_code,
      blocked: Boolean(evidence.blocked),
    })),
    security_context: securityContext,
  }));
}

function decisionDispatchReceipts(
  envelopes: Array<ValidatedAgentEnvelope | null>,
): DecisionDispatchReceipt[] {
  return envelopes.flatMap((envelope) => {
    if (!envelope || (envelope.decision_proposals ?? []).length === 0) return [];
    return [DecisionDispatchReceiptSchema.parse({
      task_id: envelope.task_id,
      workflow_epoch: envelope.workflow_epoch,
      attempt_id: envelope.attempt_id,
      generation: envelope.generation,
      lease_id: envelope.lease_id,
      decision_proposals: envelope.decision_proposals,
    })];
  });
}

function commitDecisionDispatchReceipts(
  ctx: WorkflowContext,
  receipts: DecisionDispatchReceipt[],
): void {
  for (const receipt of receipts) {
    const result = AgentResultSchema.parse({
      task_id: receipt.task_id,
      ok: true,
      summary: 'Replay validated decision proposals from a durable phase gate.',
      files_written: [],
      payload: null,
      scope_requests: [],
      decision_proposals: receipt.decision_proposals,
      workflow_epoch: receipt.workflow_epoch,
      attempt_id: receipt.attempt_id,
      generation: receipt.generation,
      lease_id: receipt.lease_id,
    });
    const envelope = validateAgentDecisions(ctx, result);
    if (
      !envelope.ok ||
      envelope.pending_decisions.length !== receipt.decision_proposals.length
    ) {
      discardDecisionProposals(ctx, envelope);
      throw new Error(
        `Dispatch ${receipt.task_id}: durable decision receipt failed revalidation`,
      );
    }
    commitDecisionProposals(ctx, envelope);
  }
}

function phaseChangeFingerprint(ctx: WorkflowContext, baseline: FileSnapshot): string {
  const current = snapshotFiles(ctx.projectRoot);
  const delta = diffSnapshots(baseline, current);
  return sha256(JSON.stringify(delta.changed.map((relative) => ({
    path: relative,
    hash: current.get(relative) ?? null,
  }))));
}

function readAcceptedReviewGate(
  pp: PhasePaths,
  inputHash: string,
): {
  approved: boolean;
  findings: ReviewPayload['findings'];
  loop: number;
  decisionDispatches: DecisionDispatchReceipt[];
} | null {
  const raw = readTextIfExists(pp.review);
  if (raw === null) return null;
  const parsed = AcceptedReviewGateSchema.safeParse(parseFrontmatter<unknown>(raw).data);
  if (!parsed.success || parsed.data.review_input_hash !== inputHash) return null;
  return {
    approved: parsed.data.approved,
    findings: parsed.data.findings,
    loop: parsed.data.loop,
    decisionDispatches: parsed.data.decision_dispatches,
  };
}

function phaseUiSmokeInputHash(
  phaseId: string,
  plan: PhasePlan,
  changeFingerprint: string,
  reviewInputHash: string,
): string {
  return sha256(JSON.stringify({
    phase: phaseId,
    plan_contract_hash: planContractHash(plan),
    change_fingerprint: changeFingerprint,
    review_input_hash: reviewInputHash,
    acceptance: [
      'No unhandled console errors',
      'No failing network requests on the main flow',
    ],
  }));
}

function uiSmokeReceiptPath(pp: PhasePaths): string {
  return path.join(path.dirname(pp.review), 'UI-SMOKE.json');
}

function normalizedProjectRelativePath(input: string): string | null {
  const slash = input.replace(/\\/g, '/');
  if (slash === '' || path.isAbsolute(input) || path.posix.isAbsolute(slash)) return null;
  const normalized = path.posix.normalize(slash);
  if (
    normalized !== slash ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) return null;
  return normalized;
}

function screenshotMediaType(target: string): z.infer<
  typeof UiSmokeReceiptSchema
>['screenshot_media_type'] | null {
  const prefix = fs.readFileSync(target).subarray(0, 12);
  if (
    prefix.length >= 8 &&
    prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return 'image/png';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return 'image/jpeg';
  }
  const header = prefix.toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function readUiSmokeReceipt(
  ctx: WorkflowContext,
  pp: PhasePaths,
  inputHash: string,
  screenshotScope: string,
): {
  result: z.infer<typeof UiSmokePayloadSchema>;
  decisionDispatches: DecisionDispatchReceipt[];
} | null {
  const parsed = UiSmokeReceiptSchema.safeParse(
    readJsonIfExists<unknown>(uiSmokeReceiptPath(pp)),
  );
  if (!parsed.success || parsed.data.input_hash !== inputHash) return null;
  const screenshot = parsed.data.result.screenshot;
  if (screenshot === null) return null;
  const normalizedScreenshot = normalizedProjectRelativePath(screenshot);
  if (
    normalizedScreenshot === null ||
    !pathInScope(normalizedScreenshot, [screenshotScope])
  ) return null;
  const absolute = path.resolve(ctx.projectRoot, normalizedScreenshot);
  const rootPrefix = `${path.resolve(ctx.projectRoot)}${path.sep}`;
  if (!absolute.startsWith(rootPrefix) || !exists(absolute)) return null;
  const screenshotStat = fs.lstatSync(absolute);
  if (!screenshotStat.isFile() || screenshotStat.isSymbolicLink()) return null;
  const mediaType = screenshotMediaType(absolute);
  if (mediaType === null || mediaType !== parsed.data.screenshot_media_type) return null;
  if (
    parsed.data.screenshot_sha256 !== sha256File(absolute) ||
    parsed.data.screenshot_size !== screenshotStat.size
  ) return null;
  return {
    result: parsed.data.result,
    decisionDispatches: parsed.data.decision_dispatches,
  };
}

function writeUiSmokeReceipt(
  ctx: WorkflowContext,
  pp: PhasePaths,
  inputHash: string,
  result: z.infer<typeof UiSmokePayloadSchema>,
  decisionDispatches: DecisionDispatchReceipt[],
  screenshotScope: string,
): void {
  if (result.screenshot === null) {
    throw new Error('UI smoke must return a project-relative screenshot path.');
  }
  const normalizedScreenshot = normalizedProjectRelativePath(result.screenshot);
  if (normalizedScreenshot === null) {
    throw new Error('UI smoke screenshot path must be normalized and project-relative.');
  }
  if (!pathInScope(normalizedScreenshot, [screenshotScope])) {
    throw new Error('UI smoke screenshot is outside the authorized screenshot scope.');
  }
  const absolute = path.resolve(ctx.projectRoot, normalizedScreenshot);
  const rootPrefix = `${path.resolve(ctx.projectRoot)}${path.sep}`;
  if (!absolute.startsWith(rootPrefix) || !exists(absolute)) {
    throw new Error('UI smoke screenshot evidence is missing or outside the project.');
  }
  const screenshotStat = fs.lstatSync(absolute);
  if (!screenshotStat.isFile() || screenshotStat.isSymbolicLink()) {
    throw new Error('UI smoke screenshot evidence must be a regular file.');
  }
  const mediaType = screenshotMediaType(absolute);
  if (mediaType === null) {
    throw new Error('UI smoke screenshot evidence must contain a supported image signature.');
  }
  const content = `${JSON.stringify({
    version: 2,
    input_hash: inputHash,
    recorded_at: ctx.now().toISOString(),
    result,
    screenshot_sha256: sha256File(absolute),
    screenshot_size: screenshotStat.size,
    screenshot_media_type: mediaType,
    decision_dispatches: decisionDispatches,
  }, null, 2)}\n`;
  persistPhaseGateFile(ctx, uiSmokeReceiptPath(pp), content);
}

function smokeNote(result: z.infer<typeof UiSmokePayloadSchema>): string {
  return `passed${result.screenshot ? ` (screenshot: ${result.screenshot})` : ''}`;
}

function renderReviewDoc(
  review: ReviewPayload,
  loop: number,
  now: () => Date,
  acceptedInputHash?: string,
  decisionDispatches: DecisionDispatchReceipt[] = [],
): string {
  return serializeFrontmatter(
      {
        approved: review.approved,
        loop,
        reviewed_at: now().toISOString(),
        findings: review.findings,
        ...(acceptedInputHash
          ? {
              gate_status: 'ACCEPTED',
              review_input_hash: acceptedInputHash,
              decision_dispatches: decisionDispatches,
            }
          : {}),
      },
      [
        `# Review`,
        '',
        review.findings.length
          ? review.findings.map((f) => `- **${f.type}** (${f.severity}): ${f.description}${f.file ? ` — ${f.file}` : ''}`).join('\n')
          : 'No findings.',
        '',
      ].join('\n'),
  );
}

function phaseGatePreimage(target: string): TxnPathState {
  if (!exists(target)) return { kind: 'absent' };
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Phase gate target is not a regular file: ${target}`);
  }
  return { kind: 'file', sha256: sha256File(target) };
}

/**
 * Persist one canonical phase gate and manifest as a recoverable transaction.
 * Startup reconciliation completes a committed partial apply before drift
 * validation runs.
 */
function persistPhaseGateFile(
  ctx: WorkflowContext,
  target: string,
  content: string,
): void {
  const manifest = readManifest(ctx.paths);
  if (!manifest) throw new Error('Cannot persist a phase gate without manifest.json.');
  const relProject = (candidate: string) =>
    path.relative(ctx.projectRoot, candidate).split(path.sep).join('/');
  const relRijo = path.relative(ctx.paths.root, target).split(path.sep).join('/');
  if (
    relRijo === '' ||
    relRijo === '..' ||
    relRijo.startsWith('../') ||
    path.isAbsolute(relRijo)
  ) {
    throw new Error('Phase gate target must be inside .rijo/.');
  }
  const overlay: HashOverlay = new Map([[relRijo, content]]);
  manifest.hashes = computeHashes(ctx.paths, overlay);
  manifest.updated_at = ctx.now().toISOString();
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const transaction = MilestoneTransaction.begin(
    ctx.paths,
    {
      kind: 'phase-gate',
      prev: exists(target) ? sha256File(target) : null,
      next: sha256(content),
    },
    ctx.txnHooks,
    ctx.now,
  );
  transaction.stageBytes(
    relProject(target),
    Buffer.from(content, 'utf8'),
    0o644,
    phaseGatePreimage(target),
  );
  transaction.stageBytes(
    relProject(ctx.paths.manifest),
    Buffer.from(manifestContent, 'utf8'),
    0o644,
    phaseGatePreimage(ctx.paths.manifest),
  );
  transaction.commitPoint();
  transaction.apply();
  transaction.finish();
}

function persistReviewDoc(
  ctx: WorkflowContext,
  pp: PhasePaths,
  review: ReviewPayload,
  loop: number,
  acceptedInputHash?: string,
  decisionDispatches: DecisionDispatchReceipt[] = [],
): void {
  persistPhaseGateFile(
    ctx,
    pp.review,
    renderReviewDoc(
      review,
      loop,
      ctx.now,
      acceptedInputHash,
      decisionDispatches,
    ),
  );
}
