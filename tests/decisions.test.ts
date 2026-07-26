import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DecisionProposalSchema,
  DecisionRecordSchema,
  decisionPolicyBrief,
  resolveDecision,
} from '../src/core/decisions.js';
import { defaultConfig } from '../src/core/config.js';
import { RijoPaths } from '../src/core/paths.js';
import { cleanup, tmpProject } from './helpers.js';

describe('autonomous decision policy', () => {
  let root: string;
  let paths: RijoPaths;

  beforeEach(() => {
    root = tmpProject('rijo-decisions-');
    paths = new RijoPaths(root);
  });

  afterEach(() => cleanup(root));

  it('defaults to autonomous, blockers-only behavior and is suitable for every agent brief', () => {
    const config = defaultConfig();
    expect(config.decisions).toMatchObject({
      mode: 'autonomous',
      ask_user: 'blockers_only',
      preserve_existing_architecture: true,
      prefer_reversible: true,
      record_material_decisions: true,
      confidence_threshold: 0.7,
      scale_horizon: 'current_scope_plus_next_milestone',
    });
    const brief = decisionPolicyBrief(config.decisions);
    expect(brief).toContain('Do not generate option menus');
    expect(brief).toContain('one factual question');
  });

  it('records a material reversible technical decision with real evidence', () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(`${root}/package.json`, '{"name":"fixture"}\n');
    const proposal = DecisionProposalSchema.parse({
      id: 'DEC-architecture-location',
      context: 'Choose where the new adapter belongs.',
      selected_option: 'Keep it in src/adapters.',
      rationale: 'The existing adapter boundary is dominant.',
      material: true,
      confidence: 0.84,
      reversible: true,
      consequences: ['No new framework or service.'],
      review_condition: 'Review if adapters stop sharing the same lifecycle.',
      evidence: [{ path: 'package.json', file_hash: expectHash(`${root}/package.json`) }],
    });
    const outcome = resolveDecision(paths, defaultConfig().decisions, proposal);
    expect(outcome.status).toBe('DECIDED');
    expect(DecisionRecordSchema.safeParse(outcome.record).success).toBe(true);
    expect(fs.readFileSync(paths.decisions, 'utf8')).toContain('DEC-architecture-location');
  });

  it('rejects invented blocker categories and asks at most one factual question for a true blocker', () => {
    expect(() =>
      DecisionProposalSchema.parse({
        id: 'DEC-invalid',
        context: 'Naming preference',
        selected_option: null,
        rationale: 'Need user preference',
        material: true,
        confidence: 0.2,
        reversible: true,
        consequences: [],
        review_condition: 'never',
        evidence: [],
        blocker: { category: 'technical_preference', missing_fact: 'favorite name', question: 'A, B, or C?' },
      }),
    ).toThrow();

    const valid = DecisionProposalSchema.parse({
      id: 'DEC-production-destruction',
      context: 'Production migration may delete customer data.',
      selected_option: null,
      rationale: 'No safe data-loss authorization exists in code or history.',
      material: true,
      confidence: 0.4,
      reversible: false,
      consequences: ['Migration is not executed.'],
      review_condition: 'Proceed only with explicit production authorization.',
      evidence: [{ path: 'package.json', file_hash: 'a'.repeat(64) }],
      blocker: {
        category: 'production_destructive_operation',
        missing_fact: 'authorization to delete production customer rows',
        question: 'Do you authorize deleting the identified production customer rows?',
      },
    });
    expect(valid.blocker?.question).not.toMatch(/\n|;|(?:\bA\b.*\bB\b)/);
    expect((valid.blocker?.question.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});

function expectHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
