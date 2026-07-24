import { z } from 'zod';
import { ModelRoleSchema } from '../core/schemas/index.js';

/**
 * Contract between the deterministic orchestrator and any agent runtime.
 * Every agent receives an explicit brief and returns a structured result.
 * Progressive context: never the whole repository.
 */
export const AgentTaskSchema = z.object({
  id: z.string(),
  role: ModelRoleSchema,
  /** concrete model tier resolved from config for this role (routing). */
  tier: z.string().optional(),
  objective: z.string().min(1),
  /** canonical .rijo files the agent must read */
  canonical_files: z.array(z.string()).default([]),
  /** code files relevant to the task */
  code_files: z.array(z.string()).default([]),
  /** files or globs the agent may write; anything else is a violation */
  write_scope: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  verification_commands: z.array(z.string()).default([]),
  /** expected shape of the textual answer (agents also write files to disk) */
  return_format: z.string().min(1),
  /** extra instructions (kept short; the brief IS the context) */
  notes: z.string().default(''),
  /**
   * Isolated attempt workspace. When present, ALL writes happen under `root`;
   * the controlled checkout is off-limits and any change there is a violation.
   * Reviewers and researchers get null (read-only by default).
   */
  workspace: z.object({ id: z.string(), root: z.string() }).nullable().default(null),
  /**
   * Immutable canonical baseline this task was briefed against: the sha256 of
   * the manifest's hash map at dispatch time. A result is only applicable
   * while this baseline is still current (checked by the core, never by the
   * agent).
   */
  canonical_baseline: z.string().nullable().default(null),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;
/** Authoring shape: fields with defaults (workspace, canonical_baseline, …) may be omitted. */
export type AgentTaskDraft = z.input<typeof AgentTaskSchema>;

export const AgentResultSchema = z.object({
  task_id: z.string(),
  ok: z.boolean(),
  /** one-line confirmation or diagnostic; NEVER the full work product */
  summary: z.string(),
  /** files the agent wrote (validated against write_scope by the orchestrator) */
  files_written: z.array(z.string()).default([]),
  /** structured payload when return_format demands one */
  payload: z.unknown().nullable().default(null),
  /** requested out-of-scope writes; require a new allocation from the orchestrator */
  scope_requests: z.array(z.string()).default([]),
});
export type AgentResult = z.infer<typeof AgentResultSchema>;

export class ScopeViolationError extends Error {
  constructor(taskId: string, files: string[]) {
    super(`Agent task ${taskId} wrote outside its declared scope: ${files.join(', ')}`);
    this.name = 'ScopeViolationError';
  }
}

/**
 * First-line scope check against the agent's self-reported files. This is a
 * courtesy check that catches honest mistakes early; the authoritative guard
 * is the filesystem-diff enforcement in core/scope.ts, which does not trust
 * the agent's report at all.
 */
export function enforceWriteScope(task: AgentTask, result: AgentResult): void {
  const norm = (s: string) => s.replace(/\\/g, '/');
  const allowed = task.write_scope.map(norm);
  if (allowed.includes('**')) return;
  const violations = result.files_written
    .map(norm)
    .filter((f) => !allowed.some((a) => f === a || (a.endsWith('/**') && f.startsWith(a.slice(0, -2))) || (a.endsWith('/') && f.startsWith(a))));
  if (violations.length > 0) throw new ScopeViolationError(task.id, violations);
}
