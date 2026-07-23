import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeWaves,
  lintPlan,
  scopesOverlap,
  parallelGroups,
  markTaskDone,
  writePlan,
  readPlan,
} from '../src/core/plan.js';
import { PlanTaskSchema, type PlanTask, type PhasePlan } from '../src/core/schemas/index.js';
import { tmpProject, cleanup } from './helpers.js';

/** Build a schema-valid task; defaults have a technical justification so lint stays quiet. */
function task(id: string, over: Partial<PlanTask> = {}): PlanTask {
  return PlanTaskSchema.parse({
    id,
    name: `Task ${id}`,
    files: [`src/${id}.ts`],
    write_scope: [`src/${id}.ts`],
    evidence_expected: 'tests pass',
    technical_justification: 'infra',
    ...over,
  });
}

describe('computeWaves', () => {
  it('assigns increasing waves along a dependency chain', () => {
    const tasks = [
      task('T01'),
      task('T02', { depends_on: ['T01'] }),
      task('T03', { depends_on: ['T02'] }),
    ];
    const waves = computeWaves(tasks);
    expect(waves.get('T01')).toBe(1);
    expect(waves.get('T02')).toBe(2);
    expect(waves.get('T03')).toBe(3);
  });

  it('puts independent tasks in the same wave', () => {
    const waves = computeWaves([task('T01'), task('T02')]);
    expect(waves.get('T01')).toBe(1);
    expect(waves.get('T02')).toBe(1);
  });

  it('throws on a dependency cycle', () => {
    const tasks = [task('T01', { depends_on: ['T02'] }), task('T02', { depends_on: ['T01'] })];
    expect(() => computeWaves(tasks)).toThrow(/cycle/i);
  });
});

describe('lintPlan', () => {
  const known = new Set(['M001-REQ-001', 'M001-REQ-002']);

  function codes(plan: PhasePlan): string[] {
    return lintPlan(plan, { knownRequirements: known }).map((i) => i.code);
  }

  it('flags MISSING_DEP for a dependency on an unknown task', () => {
    const plan: PhasePlan = {
      phase: '01',
      tasks: [task('T01', { depends_on: ['T99'] }), task('T02')],
    };
    expect(codes(plan)).toContain('MISSING_DEP');
  });

  it('flags TASK_WITHOUT_REQ when there is no requirement and no justification', () => {
    const plan: PhasePlan = {
      phase: '01',
      tasks: [task('T01', { requirement_ids: [], technical_justification: null }), task('T02')],
    };
    expect(codes(plan)).toContain('TASK_WITHOUT_REQ');
  });

  it('flags UNKNOWN_REQ for a requirement id not in the milestone', () => {
    const plan: PhasePlan = {
      phase: '01',
      tasks: [task('T01', { requirement_ids: ['M001-REQ-999'] }), task('T02')],
    };
    expect(codes(plan)).toContain('UNKNOWN_REQ');
  });

  it('flags WRITE_CONFLICT for parallel same-wave tasks sharing write scope', () => {
    const plan: PhasePlan = {
      phase: '01',
      tasks: [
        task('T01', { parallel: true, write_scope: ['src/shared.ts'] }),
        task('T02', { parallel: true, write_scope: ['src/shared.ts'] }),
      ],
    };
    expect(codes(plan)).toContain('WRITE_CONFLICT');
  });

  it('reports a dependency cycle as DEP_CYCLE instead of throwing', () => {
    const plan: PhasePlan = {
      phase: '01',
      tasks: [task('T01', { depends_on: ['T02'] }), task('T02', { depends_on: ['T01'] })],
    };
    expect(codes(plan)).toContain('DEP_CYCLE');
  });

  it('passes a clean plan with no issues', () => {
    const plan: PhasePlan = {
      phase: '01',
      tasks: [
        task('T01', { requirement_ids: ['M001-REQ-001'], technical_justification: null }),
        task('T02', { requirement_ids: ['M001-REQ-002'], depends_on: ['T01'], technical_justification: null }),
      ],
    };
    expect(lintPlan(plan, { knownRequirements: known })).toEqual([]);
  });
});

describe('scopesOverlap', () => {
  it('detects an exact file match', () => {
    expect(scopesOverlap(['src/a.ts'], ['src/a.ts'])).toBe(true);
  });

  it('detects a directory glob covering a file', () => {
    expect(scopesOverlap(['src/**'], ['src/a.ts'])).toBe(true);
    expect(scopesOverlap(['src/a.ts'], ['src/**'])).toBe(true);
  });

  it('returns false for disjoint scopes', () => {
    expect(scopesOverlap(['src/a.ts'], ['src/b.ts'])).toBe(false);
    expect(scopesOverlap(['src/**'], ['docs/readme.md'])).toBe(false);
  });
});

describe('parallelGroups', () => {
  it('does not group overlapping-scope tasks together', () => {
    const tasks = [
      task('T01', { parallel: true, write_scope: ['src/shared.ts'] }),
      task('T02', { parallel: true, write_scope: ['src/shared.ts'] }),
    ];
    const groups = parallelGroups(tasks, 4);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([['T01'], ['T02']]);
  });

  it('groups disjoint parallel same-wave tasks together', () => {
    const tasks = [
      task('T01', { parallel: true, write_scope: ['src/a.ts'] }),
      task('T02', { parallel: true, write_scope: ['src/b.ts'] }),
    ];
    const groups = parallelGroups(tasks, 4);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([['T01', 'T02']]);
  });

  it('respects maxParallel', () => {
    const tasks = [
      task('T01', { parallel: true, write_scope: ['src/a.ts'] }),
      task('T02', { parallel: true, write_scope: ['src/b.ts'] }),
      task('T03', { parallel: true, write_scope: ['src/c.ts'] }),
    ];
    const groups = parallelGroups(tasks, 2);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([['T01', 'T02'], ['T03']]);
  });

  it('runs non-parallel tasks alone and later waves after earlier ones', () => {
    const tasks = [
      task('T01', { parallel: false, write_scope: ['src/a.ts'] }),
      task('T02', { parallel: true, write_scope: ['src/b.ts'], depends_on: ['T01'] }),
      task('T03', { parallel: true, write_scope: ['src/c.ts'], depends_on: ['T01'] }),
    ];
    const groups = parallelGroups(tasks, 4);
    expect(groups.map((g) => g.map((t) => t.id))).toEqual([['T01'], ['T02', 'T03']]);
  });
});

describe('markTaskDone', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('flips done and persists it to the plan file', () => {
    const planPath = path.join(root, 'PLAN.md');
    const plan: PhasePlan = {
      phase: '01',
      tasks: [task('T01'), task('T02', { depends_on: ['T01'] })],
    };
    writePlan(planPath, plan, 'A short narrative for the phase.');

    const before = readPlan(planPath);
    expect(before.tasks.map((t) => t.done)).toEqual([false, false]);

    const returned = markTaskDone(planPath, 'T01');
    expect(returned.tasks.find((t) => t.id === 'T01')!.done).toBe(true);

    const after = readPlan(planPath);
    expect(after.tasks.find((t) => t.id === 'T01')!.done).toBe(true);
    expect(after.tasks.find((t) => t.id === 'T02')!.done).toBe(false);
  });

  it('throws for an unknown task id', () => {
    const planPath = path.join(root, 'PLAN.md');
    writePlan(planPath, { phase: '01', tasks: [task('T01'), task('T02')] }, 'narrative');
    expect(() => markTaskDone(planPath, 'T99')).toThrow(/T99 not found/);
  });
});
