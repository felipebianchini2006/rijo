import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { PhasePlanSchema, assertTaskTransition, type PhasePlan, type PlanTask, type TaskStatus } from './schemas/index.js';
import { readText, writeFileAtomic } from './fsx.js';

/**
 * PLAN.md: front matter carries the machine-readable task list, the body is a
 * short human narrative. Task `done` flags are flipped by deterministic code
 * during PERSIST — the plan file doubles as the progress checkpoint.
 */

export function readPlan(planPath: string): PhasePlan {
  const { data } = parseFrontmatter(readText(planPath));
  return PhasePlanSchema.parse(data);
}

export function writePlan(planPath: string, plan: PhasePlan, narrative: string): void {
  const body = [
    `# Plan — phase ${plan.phase}`,
    '',
    narrative.trim(),
    '',
    ...plan.tasks.map(
      (t) =>
        `- [${t.done ? 'x' : t.status === 'IMPLEMENTED' || t.status === 'VERIFYING' || t.status === 'VERIFIED' ? '~' : ' '}] ${t.id} ${t.name} [${t.status}] (${t.requirement_ids.join(', ') || 'technical'})`,
    ),
    '',
  ].join('\n');
  writeFileAtomic(planPath, serializeFrontmatter(PhasePlanSchema.parse(plan), body));
}

/**
 * Persist a validated lifecycle transition for one task. The `done` flag is
 * DERIVED (status === DONE) — it can never be flipped without walking the
 * lifecycle, so an implemented-but-unverified task is visibly partial.
 */
export function setTaskStatus(planPath: string, taskId: string, to: TaskStatus): PhasePlan {
  const plan = readPlan(planPath);
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in ${planPath}`);
  assertTaskTransition(taskId, task.status, to);
  task.status = to;
  task.done = to === 'DONE';
  const { body } = parseFrontmatter(readText(planPath));
  // regenerate checkbox lines from source of truth (front matter)
  const narrative = body
    .split('\n')
    .filter((l) => !/^- \[[ x~]\] T\d{2} /.test(l) && !/^# Plan — /.test(l))
    .join('\n');
  writePlan(planPath, plan, narrative);
  return plan;
}

export interface PlanLintIssue {
  code: string;
  message: string;
  fix: string;
}

/**
 * Deterministic plan lint: schema, dependency graph, write-scope conflicts,
 * requirement linkage. Wave numbers are computed here (plan time), never at
 * execution time.
 */
export function lintPlan(
  plan: PhasePlan,
  opts: { knownRequirements: Set<string>; phaseRequirements?: string[] },
): PlanLintIssue[] {
  const issues: PlanLintIssue[] = [];
  const ids = new Set(plan.tasks.map((t) => t.id));
  if (ids.size !== plan.tasks.length) {
    issues.push({ code: 'DUP_TASK_ID', message: 'Duplicate task IDs', fix: 'Give each task a unique T## id' });
  }
  // Bidirectional coverage: every requirement assigned to this phase must be
  // implemented by at least one task. A phase requirement with no task is a
  // silent gap that would otherwise be marked DONE without work.
  if (opts.phaseRequirements) {
    const covered = new Set(plan.tasks.flatMap((t) => t.requirement_ids));
    for (const rid of opts.phaseRequirements) {
      if (!covered.has(rid)) {
        issues.push({
          code: 'REQ_NOT_COVERED',
          message: `Requirement ${rid} is assigned to this phase but no task implements it`,
          fix: `Add a task referencing ${rid} or move the requirement to another phase`,
        });
      }
    }
  }
  for (const t of plan.tasks) {
    for (const dep of t.depends_on) {
      if (!ids.has(dep)) {
        issues.push({
          code: 'MISSING_DEP',
          message: `Task ${t.id} depends on unknown task ${dep}`,
          fix: `Remove the dependency or add task ${dep}`,
        });
      }
    }
    if (t.requirement_ids.length === 0 && !t.technical_justification) {
      issues.push({
        code: 'TASK_WITHOUT_REQ',
        message: `Task ${t.id} has no requirement and no technical justification`,
        fix: 'Link at least one requirement ID or record a technical justification',
      });
    }
    for (const rid of t.requirement_ids) {
      if (!opts.knownRequirements.has(rid)) {
        issues.push({
          code: 'UNKNOWN_REQ',
          message: `Task ${t.id} references unknown requirement ${rid}`,
          fix: 'Use an ID from the milestone REQUIREMENTS.md',
        });
      }
    }
    if (t.write_scope.length === 0) {
      issues.push({
        code: 'NO_WRITE_SCOPE',
        message: `Task ${t.id} declares no write scope`,
        fix: 'Declare the exact files or globs the worker may write',
      });
    }
  }
  // cycle detection via wave computation
  try {
    computeWaves(plan.tasks);
  } catch (err) {
    issues.push({
      code: 'DEP_CYCLE',
      message: (err as Error).message,
      fix: 'Break the dependency cycle between tasks',
    });
  }
  // parallel tasks must have disjoint write scopes with every other task in the same wave
  const waves = safeWaves(plan.tasks);
  if (waves) {
    for (const wave of waves.values()) {
      for (let i = 0; i < wave.length; i++) {
        for (let j = i + 1; j < wave.length; j++) {
          const a = wave[i]!;
          const b = wave[j]!;
          if ((a.parallel || b.parallel) && scopesOverlap(a.write_scope, b.write_scope)) {
            issues.push({
              code: 'WRITE_CONFLICT',
              message: `Tasks ${a.id} and ${b.id} are parallelizable but share write scope`,
              fix: 'Make one depend on the other or disjoin their write scopes',
            });
          }
        }
      }
    }
  }
  return issues;
}

/** wave = max(wave of deps) + 1; throws on cycles. */
export function computeWaves(tasks: PlanTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const waves = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const cached = waves.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error(`Dependency cycle involving task ${id}`);
    visiting.add(id);
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    const wave = task.depends_on.length === 0 ? 1 : Math.max(...task.depends_on.map(visit)) + 1;
    visiting.delete(id);
    waves.set(id, wave);
    return wave;
  };
  for (const t of tasks) visit(t.id);
  return waves;
}

function safeWaves(tasks: PlanTask[]): Map<number, PlanTask[]> | null {
  try {
    const waves = computeWaves(tasks);
    const grouped = new Map<number, PlanTask[]>();
    for (const t of tasks) {
      const w = waves.get(t.id)!;
      const arr = grouped.get(w) ?? [];
      arr.push(t);
      grouped.set(w, arr);
    }
    return grouped;
  } catch {
    return null;
  }
}

/** Glob-lite overlap: exact match, or one pattern's directory prefix contains the other. */
export function scopesOverlap(a: string[], b: string[]): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/\*\*?.*$/, '/');
  for (const x of a) {
    for (const y of b) {
      const nx = norm(x);
      const ny = norm(y);
      if (x === y) return true;
      if (nx.endsWith('/') && (y.startsWith(nx) || ny === nx)) return true;
      if (ny.endsWith('/') && (x.startsWith(ny) || nx === ny)) return true;
    }
  }
  return false;
}

/** Tasks eligible to run together: same wave, all flagged parallel, disjoint scopes. */
export function parallelGroups(tasks: PlanTask[], maxParallel: number): PlanTask[][] {
  const waves = safeWaves(tasks);
  if (!waves) throw new Error('Cannot group tasks: dependency cycle');
  const groups: PlanTask[][] = [];
  const sorted = [...waves.keys()].sort((a, b) => a - b);
  for (const w of sorted) {
    const wave = waves.get(w)!.filter((t) => !t.done);
    if (wave.length === 0) continue;
    let current: PlanTask[] = [];
    for (const t of wave) {
      const conflicts = current.some((c) => scopesOverlap(c.write_scope, t.write_scope));
      if (t.parallel && !conflicts && current.length < maxParallel && current.every((c) => c.parallel)) {
        current.push(t);
      } else {
        if (current.length) groups.push(current);
        current = [t];
      }
    }
    if (current.length) groups.push(current);
  }
  return groups;
}
