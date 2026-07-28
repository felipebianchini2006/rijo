import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  StatusSchema,
  RequirementSchema,
  ReviewFindingTypeSchema,
  SCHEMA_VERSION,
} from '../src/core/schemas/index.js';

describe('ConfigSchema', () => {
  it('parse({}) yields the documented defaults', () => {
    const config = ConfigSchema.parse({});
    expect(config.schema_version).toBe(SCHEMA_VERSION);
    expect(config.limits).toEqual({
      plan_revisions: 2,
      review_loops: 2,
      qa_fix_loops: 2,
      qa_defect_attempts: 2,
      qa_regression_passes: 3,
      fix_attempts: 2,
      max_parallel_agents: 4,
    });
    expect(config.context_budget_bytes).toBe(24576);
    expect(config.models).toEqual({
      lead: 'strongest',
      reviewer: 'strongest-independent',
      planner: 'balanced-reasoning',
      worker: 'economical-coding',
      researcher: 'economical-research',
      qa: 'economical-browser',
    });
    expect(config.git).toEqual({ tag_milestones: true, commit: true });
    expect(config.decisions).toMatchObject({
      mode: 'autonomous',
      ask_user: 'blockers_only',
      confidence_threshold: 0.7,
    });
    expect(config.engine_supervisor).toEqual({
      poll_interval_ms: 1_000,
      no_progress_timeout_ms: 120_000,
      hard_deadline_ms: 86_400_000,
      cancel_grace_ms: 15_000,
      kill_grace_ms: 5_000,
      max_restarts: 3,
    });
  });
});

describe('ReviewFindingTypeSchema', () => {
  it('normalizes observed host aliases without accepting arbitrary finding types', () => {
    expect(ReviewFindingTypeSchema.parse('evidence_incoherence')).toBe('quality_issue');
    expect(ReviewFindingTypeSchema.parse('specification_gap')).toBe('spec_gap');
    expect(ReviewFindingTypeSchema.parse('coverage_asymmetry')).toBe('test_gap');
    expect(ReviewFindingTypeSchema.safeParse('looks_concerning').success).toBe(false);
  });
});

describe('StatusSchema', () => {
  it('round-trips a valid snapshot', () => {
    const snapshot = {
      schema_version: SCHEMA_VERSION,
      run_id: 'run-1',
      status: 'running',
      milestone: { id: 'M001', name: 'Initial scope' },
      phase: { id: '02', index: 2, total: 3, name: 'Checkout' },
      stage: 'EXECUTE',
      task: { id: 'T01', index: 1, total: 2, name: 'Implement' },
      agent: { role: 'worker', id: 'w-1' },
      completed_units: 1,
      total_units: 4,
      last_checkpoint: 'phase 01 verified',
      started_at: '2026-07-23T12:00:00.000Z',
      updated_at: '2026-07-23T12:05:00.000Z',
      message: 'executing',
    };
    const parsed = StatusSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);
    // serialize + reparse is stable
    expect(StatusSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('rejects an invalid status value', () => {
    const res = StatusSchema.safeParse({
      schema_version: SCHEMA_VERSION,
      run_id: 'run-1',
      status: 'exploded',
      milestone: null,
      phase: null,
      stage: null,
      task: null,
      agent: null,
      completed_units: 0,
      total_units: 0,
      last_checkpoint: null,
      started_at: '2026-07-23T12:00:00.000Z',
      updated_at: '2026-07-23T12:00:00.000Z',
      message: '',
    });
    expect(res.success).toBe(false);
  });
});

describe('RequirementSchema', () => {
  const base = {
    description: 'Product catalog',
    acceptance: 'User sees the list',
    phase: '01',
  };

  it('accepts a well-formed id and applies defaults', () => {
    const req = RequirementSchema.parse({ id: 'M001-REQ-001', ...base });
    expect(req.status).toBe('PENDING');
    expect(req.classification).toBe('NEW');
    expect(req.tests).toEqual([]);
    expect(req.evidence).toBeNull();
  });

  it('rejects bad id formats', () => {
    for (const id of ['REQ-001', 'M1-REQ-001', 'M001-REQ-1', 'M001-req-001', 'M001-REQ-0001']) {
      expect(RequirementSchema.safeParse({ id, ...base }).success).toBe(false);
    }
  });
});
