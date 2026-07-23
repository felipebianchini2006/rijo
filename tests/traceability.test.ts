import { describe, it, expect } from 'vitest';
import { validateTraceability } from '../src/core/traceability.js';
import {
  RequirementSchema,
  RoadmapPhaseSchema,
  PhasePlanSchema,
  type Requirement,
  type RoadmapPhase,
  type PhasePlan,
} from '../src/core/schemas/index.js';

function req(id: string, over: Partial<Requirement> = {}): Requirement {
  return RequirementSchema.parse({
    id,
    description: 'A requirement description',
    acceptance: 'Observable acceptance criterion',
    phase: '01',
    ...over,
  });
}

function phase(id: string, over: Partial<RoadmapPhase> = {}): RoadmapPhase {
  return RoadmapPhaseSchema.parse({
    id,
    slug: `phase-${id}`,
    name: `Phase ${id}`,
    ...over,
  });
}

function codes(issues: ReturnType<typeof validateTraceability>): string[] {
  return issues.map((i) => i.code);
}

describe('validateTraceability', () => {
  it('flags ORPHAN_REQUIREMENT when phase is null', () => {
    const issues = validateTraceability({
      requirements: [req('M001-REQ-001', { phase: null })],
      phases: [phase('01')],
    });
    expect(codes(issues)).toContain('ORPHAN_REQUIREMENT');
  });

  it('flags ORPHAN_REQUIREMENT when phase is unknown', () => {
    const issues = validateTraceability({
      requirements: [req('M001-REQ-001', { phase: '99' })],
      phases: [phase('01')],
    });
    expect(codes(issues)).toContain('ORPHAN_REQUIREMENT');
  });

  it('does not flag CANCELLED requirements as orphans', () => {
    const issues = validateTraceability({
      requirements: [req('M001-REQ-001', { phase: null, status: 'CANCELLED' })],
      phases: [phase('01')],
    });
    expect(codes(issues)).not.toContain('ORPHAN_REQUIREMENT');
  });

  it('flags DONE_WITHOUT_TEST for a DONE requirement with no tests and no justification', () => {
    const issues = validateTraceability({
      requirements: [
        req('M001-REQ-001', { status: 'DONE', tests: [], evidence: 'npm test exit 0' }),
      ],
      phases: [phase('01', { requirements: ['M001-REQ-001'] })],
    });
    expect(codes(issues)).toContain('DONE_WITHOUT_TEST');
    expect(codes(issues)).not.toContain('DONE_WITHOUT_EVIDENCE');
  });

  it('accepts DONE without tests when a justification is recorded', () => {
    const issues = validateTraceability({
      requirements: [
        req('M001-REQ-001', {
          status: 'DONE',
          tests: [],
          no_test_justification: 'documentation-only change',
          evidence: 'manual review',
        }),
      ],
      phases: [phase('01', { requirements: ['M001-REQ-001'] })],
    });
    expect(codes(issues)).not.toContain('DONE_WITHOUT_TEST');
  });

  it('flags DONE_WITHOUT_EVIDENCE for a DONE requirement with no evidence', () => {
    const issues = validateTraceability({
      requirements: [
        req('M001-REQ-001', { status: 'DONE', tests: ['npm test'], evidence: null }),
      ],
      phases: [phase('01', { requirements: ['M001-REQ-001'] })],
    });
    expect(codes(issues)).toContain('DONE_WITHOUT_EVIDENCE');
    expect(codes(issues)).not.toContain('DONE_WITHOUT_TEST');
  });

  it('flags PARALLEL_WRITE_CONFLICT for independent parallel tasks sharing scope', () => {
    const plan: PhasePlan = PhasePlanSchema.parse({
      phase: '01',
      tasks: [
        {
          id: 'T01',
          name: 'Task one',
          technical_justification: 'infra',
          files: ['src/shared.ts'],
          write_scope: ['src/shared.ts'],
          parallel: true,
          evidence_expected: 'tests pass',
        },
        {
          id: 'T02',
          name: 'Task two',
          technical_justification: 'infra',
          files: ['src/shared.ts'],
          write_scope: ['src/shared.ts'],
          parallel: true,
          evidence_expected: 'tests pass',
        },
      ],
    });
    const issues = validateTraceability({
      requirements: [req('M001-REQ-001')],
      phases: [phase('01', { requirements: ['M001-REQ-001'] })],
      plans: new Map([['01', plan]]),
    });
    expect(codes(issues)).toContain('PARALLEL_WRITE_CONFLICT');
  });

  it('yields no errors for a clean input', () => {
    const plan: PhasePlan = PhasePlanSchema.parse({
      phase: '01',
      tasks: [
        {
          id: 'T01',
          name: 'Task one',
          requirement_ids: ['M001-REQ-001'],
          files: ['src/a.ts'],
          write_scope: ['src/a.ts'],
          parallel: true,
          evidence_expected: 'tests pass',
        },
        {
          id: 'T02',
          name: 'Task two',
          requirement_ids: ['M001-REQ-002'],
          files: ['src/b.ts'],
          write_scope: ['src/b.ts'],
          parallel: true,
          evidence_expected: 'tests pass',
        },
      ],
    });
    const issues = validateTraceability({
      requirements: [
        req('M001-REQ-001', { status: 'DONE', tests: ['npm test'], evidence: 'exit 0' }),
        req('M001-REQ-002'),
      ],
      phases: [phase('01', { requirements: ['M001-REQ-001', 'M001-REQ-002'] })],
      plans: new Map([['01', plan]]),
    });
    expect(issues).toEqual([]);
  });
});
