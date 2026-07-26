import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { DecisionPolicyConfig } from './schemas/index.js';
import type { RijoPaths } from './paths.js';
import { sha256File, writeFileAtomic } from './fsx.js';
import { EvidenceSchema } from '../codebase/schemas.js';

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

function appendRecord(paths: RijoPaths, record: DecisionRecord): void {
  const existing = fs.existsSync(paths.decisions) ? fs.readFileSync(paths.decisions, 'utf8').trimEnd() : '# Decisions (append-only)';
  const evidence = record.evidence
    .map((e) => `\`${e.path}\`${e.symbol ? ` — \`${e.symbol}\`` : ''}${e.lines ? ` lines ${e.lines}` : ''} sha256:${e.file_hash}`)
    .join('; ');
  const block = [
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
