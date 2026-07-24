import { z } from 'zod';

export const SCHEMA_VERSION = 2;

/** Model roles are abstract tiers; adapters map them to concrete models. */
export const ModelRoleSchema = z.enum(['lead', 'reviewer', 'planner', 'worker', 'researcher', 'qa']);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

/**
 * Concrete model mapping per provider tier. `model` is a real, host-valid
 * model name/alias — never an abstract tier string. Validated against the
 * host's known aliases at adapter-generation time.
 */
export const ClaudeTierSchema = z.object({
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']).default('medium'),
});
export const CodexTierSchema = z.object({
  model: z.string().min(1),
  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
});
export type ClaudeTier = z.infer<typeof ClaudeTierSchema>;
export type CodexTier = z.infer<typeof CodexTierSchema>;

const DEFAULT_CLAUDE_TIERS: Record<string, ClaudeTier> = {
  strongest: { model: 'opus', effort: 'high' },
  'strongest-independent': { model: 'opus', effort: 'high' },
  'balanced-reasoning': { model: 'sonnet', effort: 'high' },
  'economical-coding': { model: 'sonnet', effort: 'medium' },
  'economical-research': { model: 'haiku', effort: 'medium' },
  'economical-browser': { model: 'sonnet', effort: 'medium' },
};
const DEFAULT_CODEX_TIERS: Record<string, CodexTier> = {
  strongest: { model: 'gpt-5.2-codex', reasoning_effort: 'high' },
  'strongest-independent': { model: 'gpt-5.2-codex', reasoning_effort: 'high' },
  'balanced-reasoning': { model: 'gpt-5.2-codex', reasoning_effort: 'medium' },
  'economical-coding': { model: 'gpt-5.2-codex', reasoning_effort: 'medium' },
  'economical-research': { model: 'gpt-5.2-codex', reasoning_effort: 'low' },
  'economical-browser': { model: 'gpt-5.2-codex', reasoning_effort: 'medium' },
};

/** Viewport used by the QA gate's real browser runs. */
export const ViewportSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

/**
 * QA gate configuration: how `rijo check --production` starts, health-checks
 * and drives the application under test. `start_command` is a structured argv
 * (never a shell string).
 */
export const QaConfigSchema = z.object({
  start_command: z.array(z.string()).default([]),
  base_url: z.string().default('http://127.0.0.1:3000'),
  health_url: z.string().default(''),
  startup_timeout_ms: z.number().int().positive().default(60_000),
  shutdown_timeout_ms: z.number().int().positive().default(10_000),
  browsers: z.array(z.string()).default(['chromium']),
  viewports: z
    .array(ViewportSchema)
    .default([
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ]),
  /** journey ids explicitly waived, each with an auditable reason. */
  waivers: z.array(z.object({ journey_id: z.string(), reason: z.string().min(1) })).default([]),
});
export type QaConfig = z.infer<typeof QaConfigSchema>;

/**
 * Execution policy configuration. `sandbox: 'required'` blocks repository-code
 * execution when no OS sandbox is available; `'approved-unsandboxed'` is the
 * explicit, auditable opt-out (recorded in every evidence entry).
 */
export const ExecutionConfigSchema = z.object({
  sandbox: z.enum(['required', 'approved-unsandboxed']).default('required'),
  network_default: z.enum(['none', 'restricted', 'enabled']).default('none'),
  env_allowlist: z.array(z.string()).default([]),
  command_timeout_ms: z.number().int().positive().default(10 * 60 * 1000),
});
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;

/** Research policy: volatile decisions fail closed unless explicitly waived. */
export const ResearchConfigSchema = z.object({
  fail_closed: z.boolean().default(true),
  /** auditable waivers: topic key -> reason */
  waivers: z.array(z.object({ key: z.string(), reason: z.string().min(1) })).default([]),
  /** compact sources.json when it exceeds this many entries */
  max_sources: z.number().int().positive().default(500),
});
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;

export const ConfigSchema = z.object({
  schema_version: z.number().int().default(SCHEMA_VERSION),
  models: z
    .object({
      lead: z.string().default('strongest'),
      reviewer: z.string().default('strongest-independent'),
      planner: z.string().default('balanced-reasoning'),
      worker: z.string().default('economical-coding'),
      researcher: z.string().default('economical-research'),
      qa: z.string().default('economical-browser'),
    })
    .default({}),
  providers: z
    .object({
      claude: z.record(z.string(), ClaudeTierSchema).default(DEFAULT_CLAUDE_TIERS),
      codex: z.record(z.string(), CodexTierSchema).default(DEFAULT_CODEX_TIERS),
    })
    .default({}),
  limits: z
    .object({
      plan_revisions: z.number().int().min(0).default(2),
      review_loops: z.number().int().min(0).default(2),
      qa_fix_loops: z.number().int().min(0).default(2),
      fix_attempts: z.number().int().min(0).default(2),
      max_parallel_agents: z.number().int().min(1).default(4),
    })
    .default({}),
  context_budget_bytes: z.number().int().default(24 * 1024),
  git: z
    .object({
      tag_milestones: z.boolean().default(true),
      commit: z.boolean().default(true),
    })
    .default({}),
  qa: QaConfigSchema.default({}),
  execution: ExecutionConfigSchema.default({}),
  research: ResearchConfigSchema.default({}),
});
export type RijoConfig = z.infer<typeof ConfigSchema>;

export const MilestoneStatusSchema = z.enum([
  'ACTIVE',
  'COMPLETE',
  'PARTIAL',
  'SUPERSEDED',
  'CANCELLED',
]);
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;

export const ManifestSchema = z.object({
  rijo_version: z.string(),
  schema_version: z.number().int(),
  active_milestone: z.string().nullable(),
  milestones: z.array(
    z.object({
      id: z.string().regex(/^M\d{3}$/),
      slug: z.string(),
      status: MilestoneStatusSchema,
    }),
  ),
  hashes: z.record(z.string(), z.string()),
  updated_at: z.string(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const RunStatusSchema = z.enum(['idle', 'running', 'waiting', 'blocked', 'failed', 'completed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StageSchema = z.enum([
  'LOAD',
  'RESEARCH_DELTA',
  'SPEC_READY',
  'PLAN',
  'PLAN_LINT',
  'PLAN_REVIEW',
  'EXECUTE',
  'VERIFY',
  'CODE_REVIEW',
  'UI_SMOKE',
  'PERSIST',
  'COMMIT',
  'DONE',
  // non-run stages used by new/ui/fix/check for observable progress
  'ANALYZE',
  'RESEARCH',
  'ROADMAP',
  'IMPORT',
  'REPRODUCE',
  'DIAGNOSE',
  'REPAIR',
  'CHECKS',
  'JOURNEYS',
  'REPORT',
]);
export type Stage = z.infer<typeof StageSchema>;

export const StatusSchema = z.object({
  schema_version: z.number().int(),
  run_id: z.string(),
  status: RunStatusSchema,
  milestone: z.object({ id: z.string(), name: z.string() }).nullable(),
  phase: z
    .object({ id: z.string(), index: z.number().int(), total: z.number().int(), name: z.string() })
    .nullable(),
  stage: StageSchema.nullable(),
  task: z
    .object({ id: z.string(), index: z.number().int(), total: z.number().int(), name: z.string() })
    .nullable(),
  agent: z.object({ role: ModelRoleSchema, id: z.string() }).nullable(),
  completed_units: z.number().int(),
  total_units: z.number().int(),
  last_checkpoint: z.string().nullable(),
  started_at: z.string(),
  updated_at: z.string(),
  message: z.string(),
});
export type StatusSnapshot = z.infer<typeof StatusSchema>;

export const EventSchema = z.object({
  ts: z.string(),
  run_id: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type RijoEvent = z.infer<typeof EventSchema>;

export const RequirementStatusSchema = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'CARRIED',
  'DEBT',
  'CANCELLED',
  'BLOCKED',
]);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

export const RequirementSchema = z.object({
  id: z.string().regex(/^M\d{3}-REQ-\d{3}$/),
  description: z.string().min(1),
  acceptance: z.string().min(1),
  phase: z.string().nullable(),
  status: RequirementStatusSchema.default('PENDING'),
  classification: z
    .enum(['NEW', 'CHANGE', 'REMOVE', 'CARRYOVER', 'UNCHANGED_DEPENDENCY'])
    .default('NEW'),
  carried_from: z.string().nullable().default(null),
  /** Set on a successor requirement to mark the ancestor as terminally resolved. */
  resolves: z.string().nullable().default(null),
  tests: z.array(z.string()).default([]),
  evidence: z.string().nullable().default(null),
  no_test_justification: z.string().nullable().default(null),
});
export type Requirement = z.infer<typeof RequirementSchema>;

/**
 * Explicit task lifecycle. `done: true` is only ever derived from DONE; an
 * IMPLEMENTED task whose patch was applied but not yet verified is visibly
 * partial and is deterministically re-verified (never silently promoted) on
 * resume. Transitions are validated by `assertTaskTransition`.
 */
export const TaskStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'IMPLEMENTED',
  'VERIFYING',
  'VERIFIED',
  'DONE',
  'FAILED',
  'BLOCKED',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING: ['RUNNING', 'BLOCKED'],
  RUNNING: ['IMPLEMENTED', 'FAILED', 'BLOCKED'],
  IMPLEMENTED: ['VERIFYING', 'FAILED', 'BLOCKED'],
  VERIFYING: ['VERIFIED', 'FAILED', 'BLOCKED'],
  VERIFIED: ['DONE', 'VERIFYING', 'BLOCKED'],
  DONE: [],
  FAILED: ['PENDING'],
  BLOCKED: ['PENDING'],
};

export class InvalidTaskTransitionError extends Error {
  constructor(taskId: string, from: TaskStatus, to: TaskStatus) {
    super(`Task ${taskId}: invalid lifecycle transition ${from} → ${to}`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export function assertTaskTransition(taskId: string, from: TaskStatus, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[from].includes(to)) throw new InvalidTaskTransitionError(taskId, from, to);
}

export const PlanTaskSchema = z.object({
  id: z.string().regex(/^T\d{2}$/),
  name: z.string().min(1),
  requirement_ids: z.array(z.string()).default([]),
  technical_justification: z.string().nullable().default(null),
  files: z.array(z.string()).min(1),
  write_scope: z.array(z.string()).min(1),
  depends_on: z.array(z.string()).default([]),
  parallel: z.boolean().default(false),
  tdd: z.boolean().default(false),
  tests: z.array(z.string()).default([]),
  evidence_expected: z.string().min(1),
  /**
   * Explicit, auditable justification that this task genuinely cannot be
   * verified by an executable command (e.g. a pure documentation edit). Only
   * with this set may a task contribute zero verification commands without
   * blocking the phase. Everything else must produce real command evidence.
   */
  no_execution_justification: z.string().nullable().default(null),
  status: TaskStatusSchema.default('PENDING'),
  /** Derived convenience flag: true only when status is DONE. */
  done: z.boolean().default(false),
});
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export const PhasePlanSchema = z.object({
  phase: z.string(),
  tasks: z.array(PlanTaskSchema).min(2).max(4),
});
export type PhasePlan = z.infer<typeof PhasePlanSchema>;

export const PhaseStatusSchema = z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED']);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

export const RoadmapPhaseSchema = z.object({
  id: z.string().regex(/^\d{2}$/),
  slug: z.string(),
  name: z.string(),
  depends_on: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  status: PhaseStatusSchema.default('PENDING'),
  ui_surface: z.boolean().default(false),
  commit: z.string().nullable().default(null),
});
export type RoadmapPhase = z.infer<typeof RoadmapPhaseSchema>;

export const SourceSchema = z.object({
  claim: z.string(),
  source: z.string(),
  url: z.string(),
  checked_at: z.string(),
  version: z.string().nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']),
  used_by: z.array(z.string()).default([]),
});
export type ResearchSource = z.infer<typeof SourceSchema>;

export const ReadinessSchema = z.enum(['READY', 'NOT_READY', 'BLOCKED']);
export type Readiness = z.infer<typeof ReadinessSchema>;

export const FindingSeveritySchema = z.enum(['blocker', 'critical', 'high', 'medium', 'low']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const ReviewFindingTypeSchema = z.enum([
  'intent_gap',
  'spec_gap',
  'implementation_bug',
  'test_gap',
  'security_risk',
  'quality_issue',
  'defer',
  'reject',
]);
export type ReviewFindingType = z.infer<typeof ReviewFindingTypeSchema>;

export const StateFrontmatterSchema = z.object({
  milestone: z.string().nullable(),
  phase: z.string().nullable(),
  task: z.string().nullable(),
  stage: StageSchema.nullable(),
  last_verified: z.string().nullable(),
  last_commit: z.string().nullable(),
  next_step: z.string().nullable(),
  blocked: z.boolean().default(false),
  blocked_reason: z.string().nullable().default(null),
  updated_at: z.string(),
});
export type StateFrontmatter = z.infer<typeof StateFrontmatterSchema>;
