import { z } from 'zod';

export const SCHEMA_VERSION = 4;

/**
 * A boolean field an LLM fills that may arrive as a string ("true"/"false"/
 * "yes"/"1"/"0"): coerce the common textual forms so a correctly-INTENDED value
 * in a slightly off-type shape is honored instead of failing a whole payload,
 * and fall back (via `.catch`) to `fallback` for anything unrecognizable. Used
 * only for model-authored booleans — never for core-managed state.
 */
export function looseBool(fallback: boolean): z.ZodType<boolean> {
  return z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (['true', '1', 'yes'].includes(s)) return true;
        if (['false', '0', 'no'].includes(s)) return false;
      }
      return v;
    }, z.boolean())
    .catch(fallback) as unknown as z.ZodType<boolean>;
}

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
// Codex model IDs verified against https://developers.openai.com/codex/models
// (redirects to https://learn.chatgpt.com/docs/models), checked 2026-07-24:
// gpt-5.6-sol (flagship), gpt-5.6-terra (balanced), gpt-5.6-luna (fast).
// gpt-5.2* and gpt-5.3-codex are documented as DEPRECATED, so the previous
// 'gpt-5.2-codex' default is corrected here to the current flagship line.
const DEFAULT_CODEX_TIERS: Record<string, CodexTier> = {
  strongest: { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
  'strongest-independent': { model: 'gpt-5.6-sol', reasoning_effort: 'high' },
  'balanced-reasoning': { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
  'economical-coding': { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
  'economical-research': { model: 'gpt-5.6-luna', reasoning_effort: 'low' },
  'economical-browser': { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
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

/**
 * Supervisor policy: no agent attempt may block a workflow indefinitely.
 * Liveness (heartbeat) is generated by the runtime/host controller — never by
 * paid model messages; the model does not decide whether it is alive. All
 * waits are bounded; every limit below is configurable with safe defaults.
 */
export const SupervisorConfigSchema = z.object({
  heartbeat_interval_ms: z.number().int().positive().default(15_000),
  heartbeat_grace_ms: z.number().int().positive().default(45_000),
  no_progress_timeout_ms: z
    .object({
      lead: z.number().int().positive().default(300_000),
      planner: z.number().int().positive().default(300_000),
      worker: z.number().int().positive().default(300_000),
      reviewer: z.number().int().positive().default(240_000),
      researcher: z.number().int().positive().default(180_000),
      qa: z.number().int().positive().default(300_000),
    })
    .default({}),
  hard_timeout_ms: z
    .object({
      lead: z.number().int().positive().default(900_000),
      planner: z.number().int().positive().default(900_000),
      worker: z.number().int().positive().default(1_200_000),
      reviewer: z.number().int().positive().default(900_000),
      researcher: z.number().int().positive().default(600_000),
      qa: z.number().int().positive().default(1_200_000),
    })
    .default({}),
  cancel_grace_ms: z.number().int().positive().default(15_000),
  hard_kill_grace_ms: z.number().int().positive().default(5_000),
  max_replacements_per_task: z.number().int().min(0).default(2),
  max_total_task_elapsed_ms: z.number().int().positive().default(2_400_000),
  replacement_backoff_ms: z.array(z.number().int().nonnegative()).default([1_000, 5_000]),
});
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

/**
 * Host runtime binding. `provider` names the CLI host RIJO drives turnkey
 * (`rijo run --host <provider>` or this default). `none` (the default) leaves
 * RIJO host-agnostic: an adapter/embedder binds the runtime, or the operator
 * passes `--host` explicitly. Additive over schema v2 — an absent block parses
 * to `{ provider: 'none' }` and changes no existing field.
 */
export const HostConfigSchema = z.object({
  provider: z.enum(['claude', 'codex', 'none']).default('none'),
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

/**
 * Persisted per-logical-task supervision state. Only the CURRENT generation
 * holding the CURRENT lease can produce an applicable result; anything else
 * is disposed as LATE_OR_STALE_RESULT and never applied.
 */
export const SupervisedTaskStateSchema = z.enum([
  'QUEUED',
  'STARTING',
  'RUNNING',
  'SUSPECT',
  'CANCELLING',
  'CANCELLED',
  'REPLACING',
  'SUCCEEDED',
  'FAILED',
  'EXHAUSTED',
  'ORPHANED',
]);
export type SupervisedTaskState = z.infer<typeof SupervisedTaskStateSchema>;

const SUPERVISED_TRANSITIONS: Record<SupervisedTaskState, SupervisedTaskState[]> = {
  QUEUED: ['STARTING', 'CANCELLED'],
  STARTING: ['RUNNING', 'FAILED', 'CANCELLING', 'ORPHANED'],
  RUNNING: ['SUSPECT', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'ORPHANED'],
  SUSPECT: ['RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'ORPHANED'],
  CANCELLING: ['CANCELLED', 'FAILED', 'ORPHANED'],
  CANCELLED: ['REPLACING', 'EXHAUSTED'],
  REPLACING: ['STARTING', 'EXHAUSTED'],
  SUCCEEDED: [],
  FAILED: ['REPLACING', 'EXHAUSTED'],
  EXHAUSTED: [],
  ORPHANED: ['CANCELLING', 'CANCELLED', 'REPLACING', 'EXHAUSTED'],
};

export class InvalidSupervisedTransitionError extends Error {
  constructor(taskId: string, from: SupervisedTaskState, to: SupervisedTaskState) {
    super(`Supervised task ${taskId}: invalid transition ${from} → ${to} (core error)`);
    this.name = 'InvalidSupervisedTransitionError';
  }
}

export function assertSupervisedTransition(taskId: string, from: SupervisedTaskState, to: SupervisedTaskState): void {
  if (!SUPERVISED_TRANSITIONS[from].includes(to)) throw new InvalidSupervisedTransitionError(taskId, from, to);
}

/** Durable task record: .rijo/runtime/tasks/<logical-task-id>.json */
export const TaskRecordSchema = z.object({
  logical_task_id: z.string(),
  attempt_id: z.string(),
  generation: z.number().int().min(1),
  lease_id: z.string(),
  idempotency_key: z.string(),
  role: ModelRoleSchema,
  expert_profiles: z.array(z.string()).default([]),
  host: z.string().default('unbound'),
  host_session_id: z.string().nullable().default(null),
  host_thread_id: z.string().nullable().default(null),
  host_turn_id: z.string().nullable().default(null),
  host_process_id: z.number().int().nullable().default(null),
  workspace_id: z.string().nullable().default(null),
  workspace_path: z.string().nullable().default(null),
  baseline_commit: z.string().nullable().default(null),
  canonical_baseline_hash: z.string().nullable().default(null),
  state: SupervisedTaskStateSchema,
  created_at: z.string(),
  started_at: z.string().nullable().default(null),
  last_heartbeat_at: z.string().nullable().default(null),
  last_progress_at: z.string().nullable().default(null),
  soft_deadline_at: z.string().nullable().default(null),
  hard_deadline_at: z.string().nullable().default(null),
  cancel_requested_at: z.string().nullable().default(null),
  cancel_acknowledged_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  replacement_count: z.number().int().min(0).default(0),
  last_error: z.string().nullable().default(null),
  /** revoked leases: results carrying any of these are fenced out. */
  revoked_leases: z.array(z.string()).default([]),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

/** Research policy: volatile decisions fail closed unless explicitly waived. */
export const ResearchConfigSchema = z.object({
  fail_closed: z.boolean().default(true),
  /** auditable waivers: topic key -> reason */
  waivers: z.array(z.object({ key: z.string(), reason: z.string().min(1) })).default([]),
  /** compact sources.json when it exceeds this many entries */
  max_sources: z.number().int().positive().default(500),
});
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;

export const DecisionPolicyConfigSchema = z.object({
  mode: z.literal('autonomous').default('autonomous'),
  ask_user: z.literal('blockers_only').default('blockers_only'),
  preserve_existing_architecture: z.boolean().default(true),
  prefer_reversible: z.boolean().default(true),
  record_material_decisions: z.boolean().default(true),
  confidence_threshold: z.number().min(0).max(1).default(0.7),
  scale_horizon: z.literal('current_scope_plus_next_milestone').default('current_scope_plus_next_milestone'),
});
export type DecisionPolicyConfig = z.infer<typeof DecisionPolicyConfigSchema>;

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
  decisions: DecisionPolicyConfigSchema.default({}),
  supervisor: SupervisorConfigSchema.default({}),
  host: HostConfigSchema.default({}),
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
  'MAP_PREFLIGHT',
  'MAP_INVENTORY',
  'MAP_HISTORY',
  'MAP_SHARDS',
  'MAP_SYNTHESIS',
  'MAP_REVIEW',
  'MAP_BASELINE',
  'MAP_COMMIT',
  'MAP_DONE',
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

export const ExistingMappedReferenceSchema = z.object({
  path: z.string().min(1),
  intent: z.literal('existing'),
  file_hash: z.string().regex(/^[a-f0-9]{64}$/),
  symbol: z.string().min(1).optional(),
});

export const NewMappedReferenceSchema = z.object({
  path: z.string().min(1),
  intent: z.literal('new'),
  parent_module: z.string().min(1),
  placement_evidence: z
    .array(
      z.object({
        path: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .min(1),
});

export const MappedReferenceSchema = z.discriminatedUnion('intent', [
  ExistingMappedReferenceSchema,
  NewMappedReferenceSchema,
]);
export type MappedReference = z.infer<typeof MappedReferenceSchema>;

export const PlanTaskSchema = z.object({
  id: z.string().regex(/^T\d{2}$/),
  name: z.string().min(1),
  requirement_ids: z.array(z.string()).default([]),
  technical_justification: z.string().nullable().default(null),
  files: z.array(z.string()).min(1),
  /**
   * Explicit intent for every task file. This field deliberately has no
   * default: a planner must prove an existing path/hash (and optional symbol)
   * or prove placement for a new file. Legacy plans are migrated/invalidate
   * explicitly by the workflow and never parsed through a permissive default.
   */
  mapped_references: z.array(MappedReferenceSchema).min(1),
  write_scope: z.array(z.string()).min(1),
  depends_on: z.array(z.string()).default([]),
  parallel: looseBool(false),
  tdd: looseBool(false),
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

export const PlanFreshnessSchema = z.object({
  mapped_commit: z.string().min(1),
  mapped_tree_hash: z.string().min(1),
  planned_at: z.string().datetime(),
  context_packet_hash: z.string().regex(/^[a-f0-9]{64}$/),
  mapped_reference_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  decision_context_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type PlanFreshness = z.infer<typeof PlanFreshnessSchema>;

/** Planner-authored shape. Freshness is stamped by the deterministic core. */
export const PhasePlanDraftSchema = z.object({
  phase: z.string(),
  tasks: z.array(PlanTaskSchema).min(2).max(4),
});
export type PhasePlanDraft = z.infer<typeof PhasePlanDraftSchema>;

/** Persisted PLAN.md shape. Every plan is tied to one exact map/context. */
export const PhasePlanSchema = PhasePlanDraftSchema.merge(PlanFreshnessSchema);
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
  /** provenance tier: volatile decisions require official docs or a primary advisory. */
  tier: z.enum(['official', 'advisory', 'secondary']).default('secondary'),
  used_by: z.array(z.string()).default([]),
});
export type ResearchSource = z.infer<typeof SourceSchema>;

export const ReadinessSchema = z.enum(['READY', 'NOT_READY', 'BLOCKED']);
export type Readiness = z.infer<typeof ReadinessSchema>;

export const FindingSeveritySchema = z.enum(['blocker', 'critical', 'high', 'medium', 'low']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

const REVIEW_FINDING_TYPE_ALIASES: Record<string, string> = {
  evidence_incoherence: 'quality_issue',
  specification_gap: 'spec_gap',
  coverage_gap: 'test_gap',
  coverage_asymmetry: 'test_gap',
  test_coverage_gap: 'test_gap',
  implementation_error: 'implementation_bug',
  security_issue: 'security_risk',
};

export const ReviewFindingTypeSchema = z.preprocess(
  (value) =>
    typeof value === 'string'
      ? (REVIEW_FINDING_TYPE_ALIASES[value.trim().toLowerCase()] ?? value.trim().toLowerCase())
      : value,
  z.enum([
    'intent_gap',
    'spec_gap',
    'implementation_bug',
    'test_gap',
    'security_risk',
    'quality_issue',
    'defer',
    'reject',
  ]),
);
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
