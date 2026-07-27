import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { DecisionPolicyConfig } from './schemas/index.js';
import type { RijoPaths } from './paths.js';
import { ensureDir, readJsonIfExists, sha256, sha256File, writeFileAtomic, writeJsonAtomic } from './fsx.js';
import { EvidenceSchema } from '../codebase/schemas.js';
import { touchManifest } from './manifest.js';

export const DecisionBlockerCategorySchema = z.enum([
  'external_business_rule',
  'explicit_requirement_conflict',
  'required_external_access',
  'production_destructive_operation',
  'legal_fiscal_regulatory_compliance',
  'paid_commitment_or_lock_in',
  'data_loss_risk',
]);
export type DecisionBlockerCategory = z.infer<typeof DecisionBlockerCategorySchema>;

export const DecisionProposalSchema = z
  .object({
    id: z.string().regex(/^DEC-[A-Za-z0-9][A-Za-z0-9._-]*$/),
    context: z.string().min(1),
    selected_option: z.string().min(1).nullable(),
    rationale: z.string().min(1),
    material: z.boolean(),
    impact: z.enum(['low', 'medium', 'high']).default('medium'),
    confidence: z.number().min(0).max(1),
    reversible: z.boolean(),
    consequences: z.array(z.string()),
    review_condition: z.string().min(1),
    evidence: z.array(EvidenceSchema),
    blocker: z
      .object({
        category: DecisionBlockerCategorySchema,
        missing_fact: z.string().min(1),
        question: z
          .string()
          .min(1)
          .refine((q) => !q.includes('\n'), 'blocker question must be one factual line')
          .refine((q) => (q.match(/\?/g) ?? []).length <= 1, 'blocker may ask at most one factual question')
          .refine((q) => !/(?:^|\s)(?:A|B|C|1|2|3)[).:]\s/.test(q), 'blocker question cannot contain an option menu'),
      })
      .nullable()
      .default(null),
  })
  .superRefine((value, ctx) => {
    if (value.material && value.evidence.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'material decisions require evidence' });
    }
    if (value.blocker && value.selected_option !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selected_option'], message: 'a blocked proposal cannot claim a selected option' });
    }
    if (!value.blocker && value.selected_option === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selected_option'], message: 'an autonomous decision needs a selected option' });
    }
  });
export type DecisionProposal = z.infer<typeof DecisionProposalSchema>;

export const DecisionRecordSchema = z.object({
  id: z.string(),
  decided_at: z.string(),
  context: z.string(),
  selected_option: z.string(),
  rationale: z.string(),
  evidence: z.array(EvidenceSchema).min(1),
  confidence: z.number().min(0).max(1),
  reversible: z.boolean(),
  impact: z.enum(['low', 'medium', 'high']),
  consequences: z.array(z.string()),
  review_condition: z.string(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export type DecisionOutcome =
  | { status: 'DECIDED'; record: DecisionRecord | null; note: string }
  | { status: 'BLOCKED'; category: DecisionBlockerCategory; missing_fact: string; question: string; note: string };

export function decisionPolicyBrief(policy: DecisionPolicyConfig): string {
  return [
    'AUTONOMOUS DECISION POLICY',
    `Mode=${policy.mode}; ask_user=${policy.ask_user}; confidence_threshold=${policy.confidence_threshold}.`,
    'Resolve gray areas in this order: explicit scope/acceptance; observed contracts/tests/data/current behavior; mapped architecture and dominant conventions; security/data integrity/compatibility; official stable stack guidance; simplest reversible low-operations solution; scale needed for current scope plus the next likely milestone.',
    'Preserve the existing stack and architecture. Do not introduce a framework, database, service, queue, microservice, or structural dependency without demonstrated necessity.',
    'For equivalent reversible choices, select the simplest one. Below the confidence threshold, preserve current behavior or choose the simplest reversible option and record an objective review condition.',
    'Do not generate option menus, preference questions, or confirmation prompts for technical decisions. A true blocker may ask at most one factual question and must use an allowed blocker category.',
    'Material decisions require real file evidence and are recorded; trivial implementation details are not.',
  ].join('\n');
}

function validateEvidence(paths: RijoPaths, proposal: DecisionProposal): void {
  for (const evidence of proposal.evidence) {
    const absolute = path.resolve(paths.projectRoot, evidence.path);
    const rel = path.relative(paths.projectRoot, absolute);
    if (path.isAbsolute(rel) || rel.startsWith('..') || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Decision ${proposal.id}: evidence path does not exist in the project: ${evidence.path}`);
    }
    if (sha256File(absolute) !== evidence.file_hash) {
      throw new Error(`Decision ${proposal.id}: evidence hash mismatch for ${evidence.path}`);
    }
    const text = fs.readFileSync(absolute, 'utf8');
    if (evidence.lines) {
      const [start, end = start] = evidence.lines.split('-').map(Number);
      const count = text.split(/\r?\n/).length;
      if (!start || !end || start > end || end > count) {
        throw new Error(`Decision ${proposal.id}: evidence lines are invalid for ${evidence.path}`);
      }
    }
    if (evidence.symbol && !text.includes(evidence.symbol.split('.').at(-1)!)) {
      throw new Error(`Decision ${proposal.id}: evidence symbol does not exist in ${evidence.path}`);
    }
  }
}

function appendRecord(paths: RijoPaths, record: DecisionRecord, idempotencyKey?: string): void {
  const existing = fs.existsSync(paths.decisions) ? fs.readFileSync(paths.decisions, 'utf8').trimEnd() : '# Decisions (append-only)';
  const marker = idempotencyKey ? `<!-- decision-idempotency:${idempotencyKey} -->` : '';
  if (marker && existing.includes(marker)) return;
  const escapedId = record.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^## ${escapedId}$`, 'm').test(existing)) return;
  const evidence = record.evidence
    .map((e) => `\`${e.path}\`${e.symbol ? ` — \`${e.symbol}\`` : ''}${e.lines ? ` lines ${e.lines}` : ''} sha256:${e.file_hash}`)
    .join('; ');
  const block = [
    marker,
    `## ${record.id}`,
    '',
    `- Decided at: ${record.decided_at}`,
    `- Context: ${record.context}`,
    `- Selected: ${record.selected_option}`,
    `- Evidence: ${evidence}`,
    `- Rationale: ${record.rationale}`,
    `- Confidence: ${record.confidence.toFixed(2)}`,
    `- Reversible: ${record.reversible ? 'yes' : 'no'}`,
    `- Impact: ${record.impact}`,
    `- Consequences: ${record.consequences.join('; ') || 'none identified'}`,
    `- Review when: ${record.review_condition}`,
  ].join('\n');
  writeFileAtomic(paths.decisions, `${existing}\n\n${block}\n`);
}

export interface PendingDecision {
  proposal: DecisionProposal;
  idempotency_key: string;
  task_id: string;
  attempt_id: string;
  generation: number;
}

export interface DecisionCommitHooks {
  afterPrepared?: () => void;
  afterAppend?: () => void;
  afterManifest?: () => void;
}

const DecisionJournalSchema = z.object({
  schema_version: z.literal(1),
  idempotency_key: z.string().regex(/^[a-f0-9]{64}$/),
  task_id: z.string().min(1),
  attempt_id: z.string().min(1),
  generation: z.number().int().min(1),
  proposal: DecisionProposalSchema,
  record: DecisionRecordSchema.nullable().optional(),
  status: z.enum(['PREPARED', 'APPENDED', 'MANIFESTED']),
  updated_at: z.string().datetime(),
});
type DecisionJournal = z.infer<typeof DecisionJournalSchema>;

function decisionJournalDir(paths: RijoPaths): string {
  return path.join(paths.runtimeDir, 'decision-commits');
}

function decisionJournalPath(paths: RijoPaths, key: string): string {
  return path.join(decisionJournalDir(paths), `${key}.json`);
}

export function decisionIdempotencyKey(
  decisionId: string,
  taskId: string,
  attemptId: string,
  generation: number,
): string {
  return sha256(`${decisionId}\0${taskId}\0${attemptId}\0${generation}`);
}

export function prepareDecision(
  paths: RijoPaths,
  policy: DecisionPolicyConfig,
  raw: unknown,
  identity: { task_id: string; attempt_id: string; generation: number },
  now: () => Date = () => new Date(),
): PendingDecision | DecisionOutcome {
  const proposal = DecisionProposalSchema.parse(raw);
  const outcome = resolveDecision(
    paths,
    { ...policy, record_material_decisions: false },
    proposal,
    now,
  );
  if (outcome.status === 'BLOCKED') return outcome;
  return {
    proposal,
    idempotency_key: decisionIdempotencyKey(
      proposal.id,
      identity.task_id,
      identity.attempt_id,
      identity.generation,
    ),
    task_id: identity.task_id,
    attempt_id: identity.attempt_id,
    generation: identity.generation,
  };
}

export function commitPendingDecision(
  paths: RijoPaths,
  policy: DecisionPolicyConfig,
  pending: PendingDecision,
  now: () => Date = () => new Date(),
  hooks: DecisionCommitHooks = {},
): DecisionOutcome {
  const target = decisionJournalPath(paths, pending.idempotency_key);
  const existing = DecisionJournalSchema.safeParse(readJsonIfExists<unknown>(target));
  if (existing.success && existing.data.status === 'MANIFESTED') {
    return {
      status: 'DECIDED',
      record: existing.data.record ?? null,
      note: `Decision ${pending.proposal.id} was already committed transactionally.`,
    };
  }
  ensureDir(decisionJournalDir(paths));
  const journal: DecisionJournal = existing.success
    ? existing.data
    : DecisionJournalSchema.parse({
        schema_version: 1,
        ...pending,
        status: 'PREPARED',
        updated_at: now().toISOString(),
      });
  writeJsonAtomic(target, journal);
  hooks.afterPrepared?.();

  if (journal.status === 'APPENDED') {
    if (fs.existsSync(paths.manifest)) touchManifest(paths, () => {}, now);
    writeJsonAtomic(target, { ...journal, status: 'MANIFESTED', updated_at: now().toISOString() });
    hooks.afterManifest?.();
    return {
      status: 'DECIDED',
      record: journal.record ?? null,
      note: `Decision ${journal.proposal.id} recovered after its append stage.`,
    };
  }

  const outcome = resolveDecision(
    paths,
    { ...policy, record_material_decisions: false },
    journal.proposal,
    now,
  );
  if (outcome.status === 'BLOCKED') return outcome;
  if (outcome.record && policy.record_material_decisions) {
    appendRecord(paths, outcome.record, journal.idempotency_key);
  }
  writeJsonAtomic(target, {
    ...journal,
    record: outcome.record,
    status: 'APPENDED',
    updated_at: now().toISOString(),
  });
  hooks.afterAppend?.();

  if (fs.existsSync(paths.manifest)) touchManifest(paths, () => {}, now);
  writeJsonAtomic(target, { ...journal, status: 'MANIFESTED', updated_at: now().toISOString() });
  hooks.afterManifest?.();
  return outcome;
}

export function reconcileDecisionCommits(
  paths: RijoPaths,
  policy: DecisionPolicyConfig,
  now: () => Date = () => new Date(),
): string[] {
  const dir = decisionJournalDir(paths);
  if (!fs.existsSync(dir)) return [];
  const reconciled: string[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
    const target = path.join(dir, name);
    const parsed = DecisionJournalSchema.safeParse(readJsonIfExists<unknown>(target));
    if (!parsed.success || parsed.data.status === 'MANIFESTED') continue;
    const pending: PendingDecision = {
      proposal: parsed.data.proposal,
      idempotency_key: parsed.data.idempotency_key,
      task_id: parsed.data.task_id,
      attempt_id: parsed.data.attempt_id,
      generation: parsed.data.generation,
    };
    commitPendingDecision(paths, policy, pending, now);
    reconciled.push(parsed.data.idempotency_key);
  }
  return reconciled;
}

export function resolveDecision(
  paths: RijoPaths,
  policy: DecisionPolicyConfig,
  raw: DecisionProposal,
  now: () => Date = () => new Date(),
): DecisionOutcome {
  const proposal = DecisionProposalSchema.parse(raw);
  validateEvidence(paths, proposal);
  if (proposal.blocker) {
    if (proposal.reversible && proposal.confidence < policy.confidence_threshold) {
      throw new Error(
        `Decision ${proposal.id}: reversible technical uncertainty is not an allowed blocker; preserve current behavior or choose the simplest reversible option.`,
      );
    }
    return {
      status: 'BLOCKED',
      category: proposal.blocker.category,
      missing_fact: proposal.blocker.missing_fact,
      question: proposal.blocker.question,
      note: `Code, history, tests, and the codebase map did not establish: ${proposal.blocker.missing_fact}`,
    };
  }

  if (
    proposal.confidence < policy.confidence_threshold &&
    (!proposal.reversible || proposal.impact === 'high')
  ) {
    throw new Error(
      `Decision ${proposal.id}: low-confidence irreversible/high-impact decisions must use an allowed factual blocker category.`,
    );
  }
  const record = proposal.material
    ? DecisionRecordSchema.parse({
        id: proposal.id,
        decided_at: now().toISOString(),
        context: proposal.context,
        selected_option: proposal.selected_option,
        rationale: proposal.rationale,
        evidence: proposal.evidence,
        confidence: proposal.confidence,
        reversible: proposal.reversible,
        impact: proposal.impact,
        consequences: proposal.consequences,
        review_condition: proposal.review_condition,
      })
    : null;
  if (record && policy.record_material_decisions) appendRecord(paths, record);
  return {
    status: 'DECIDED',
    record,
    note:
      proposal.confidence < policy.confidence_threshold
        ? `Decision recorded below threshold; review condition: ${proposal.review_condition}`
        : 'Decision resolved autonomously from evidence.',
  };
}
