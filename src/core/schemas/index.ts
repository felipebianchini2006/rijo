import { z } from 'zod';

export const SCHEMA_VERSION = 1;

/** Model roles are abstract tiers; adapters map them to concrete models. */
export const ModelRoleSchema = z.enum(['lead', 'reviewer', 'planner', 'worker', 'researcher', 'qa']);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

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
