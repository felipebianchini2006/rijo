import * as path from 'node:path';
import { z } from 'zod';
import { exists, readText, writeFileAtomic, ensureDir } from '../core/fsx.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { phasePaths, type PhasePaths } from '../core/paths.js';
import { readState, writeState, initialState } from '../core/state.js';
import { touchManifest } from '../core/manifest.js';
import { activeMilestone, type MilestoneRef } from '../core/milestones.js';
import { readRequirements, readRoadmap, writeRequirements, writeRoadmap, nextPhase, type RoadmapDoc } from '../core/roadmap.js';
import { readPlan, writePlan, lintPlan, markTaskDone, parallelGroups } from '../core/plan.js';
import { validateStateIntegrity } from '../core/traceability.js';
import { checkContextBudget } from '../core/contextBudget.js';
import { PhasePlanSchema, ReviewFindingTypeSchema, FindingSeveritySchema, type RoadmapPhase, type PhasePlan } from '../core/schemas/index.js';
import type { CommandEvidence } from '../core/commands.js';
import { runBatch, runValidated } from '../agents/runner.js';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';

export interface RunOptions {
  /** undefined = resume from STATE.md; 'next' = next ready phase; 'all' = every phase; 'NN' = specific phase */
  target?: string;
}

const ReviewPayloadSchema = z.object({
  approved: z.boolean(),
  findings: z
    .array(
      z.object({
        type: ReviewFindingTypeSchema,
        severity: FindingSeveritySchema.default('medium'),
        description: z.string(),
        file: z.string().nullable().default(null),
      }),
    )
    .default([]),
});
type ReviewPayload = z.infer<typeof ReviewPayloadSchema>;

const UiSmokePayloadSchema = z.object({
  passed: z.boolean(),
  console_errors: z.array(z.string()).default([]),
  network_errors: z.array(z.string()).default([]),
  screenshot: z.string().nullable().default(null),
  notes: z.string().default(''),
});

export async function runWorkflow(
  projectRoot: string,
  opts: RunOptions = {},
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  const { paths, bus } = ctx;

  if (!exists(paths.manifest)) {
    return failed(ctx, 'No RIJO project here. Run `rijo new @PLAN.md` first.');
  }

  return withLock(ctx, async () => {
    // ---- LOAD
    bus.emit('run.load', { status: 'running', stage: 'LOAD', message: 'validando manifest, drift e checkpoint' });
    const integrity = validateStateIntegrity(paths);
    const errors = integrity.filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      return blocked(ctx, 'State integrity check failed.', errors.map((e) => `${e.code}: ${e.message} — ${e.fix}`));
    }
    const milestone = activeMilestone(paths);
    if (!milestone) return failed(ctx, 'No active milestone in manifest.');
    if (!exists(milestone.paths.roadmap)) return failed(ctx, `Missing ROADMAP.md for ${milestone.id}.`);

    const budget = checkContextBudget(
      [paths.rules, paths.state, milestone.paths.requirements],
      ctx.config.context_budget_bytes,
    );
    if (!budget.withinBudget) {
      bus.emit('run.budget_warning', { message: `contexto automático ${budget.bytes}B excede orçamento ${budget.budget}B` });
    }

    const roadmap = readRoadmap(milestone.paths.roadmap);
    const targets = resolveTargets(ctx, roadmap, opts.target);
    if (targets.length === 0) {
      const allDone = roadmap.phases.every((p) => p.status === 'DONE');
      return completed(
        ctx,
        allDone ? `All ${roadmap.phases.length} phases of ${milestone.id} are DONE.` : 'No ready phase (check dependencies/blockers).',
      );
    }

    for (const phase of targets) {
      const outcome = await executePhase(ctx, milestone, phase);
      if (!outcome.ok) return outcome;
      if (opts.target !== 'all') return outcome;
    }
    return completed(ctx, `Completed ${targets.length} phase(s) of ${milestone.id}.`);
  });
}

function resolveTargets(ctx: WorkflowContext, roadmap: RoadmapDoc, target?: string): RoadmapPhase[] {
  if (target && /^\d{2}$/.test(target)) {
    const phase = roadmap.phases.find((p) => p.id === target);
    if (!phase) throw new Error(`Phase ${target} not found in roadmap`);
    return phase.status === 'DONE' ? [] : [phase];
  }
  if (target === 'all') {
    // sequential order respecting deps: repeatedly pick next ready
    const list: RoadmapPhase[] = [];
    const sim = new Set(roadmap.phases.filter((p) => p.status === 'DONE').map((p) => p.id));
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const p of roadmap.phases) {
        if (p.status === 'DONE' || sim.has(p.id) || list.includes(p)) continue;
        if (p.depends_on.every((d) => sim.has(d))) {
          list.push(p);
          sim.add(p.id);
          progressed = true;
        }
      }
    }
    return list;
  }
  // resume from STATE.md, else next ready
  const state = readState(ctx.paths);
  if (!target && state?.phase) {
    const phase = roadmap.phases.find((p) => p.id === state.phase && p.status !== 'DONE');
    if (phase) return [phase];
  }
  const np = nextPhase(roadmap);
  return np ? [np] : [];
}

async function executePhase(
  ctx: WorkflowContext,
  milestone: MilestoneRef,
  phase: RoadmapPhase,
): Promise<WorkflowOutcome> {
  const { paths, bus, config, now } = ctx;
  const roadmap = readRoadmap(milestone.paths.roadmap);
  const phaseIndex = roadmap.phases.findIndex((p) => p.id === phase.id) + 1;
  const phaseDir = path.join(milestone.paths.phasesDir, `${phase.id}-${phase.slug}`);
  ensureDir(phaseDir);
  const pp = phasePaths(phaseDir);
  const phaseInfo = { id: phase.id, index: phaseIndex, total: roadmap.phases.length, name: phase.name };
  const milestoneInfo = { id: milestone.id, name: milestone.slug };
  const stage = (s: import('../core/schemas/index.js').Stage, message: string, extra: Record<string, unknown> = {}) =>
    bus.emit(`run.${s.toLowerCase()}`, { status: 'running', stage: s, milestone: milestoneInfo, phase: phaseInfo, message }, extra);

  const markPhase = (status: RoadmapPhase['status'], commit?: string | null) => {
    const doc = readRoadmap(milestone.paths.roadmap);
    const p = doc.phases.find((x) => x.id === phase.id)!;
    p.status = status;
    if (commit !== undefined) p.commit = commit;
    writeRoadmap(milestone.paths.roadmap, doc);
  };

  const checkpoint = (stageName: import('../core/schemas/index.js').Stage, narrative: string, extra: Partial<import('../core/schemas/index.js').StateFrontmatter> = {}) => {
    const prev = readState(paths) ?? initialState(now);
    writeState(
      paths,
      {
        ...prev,
        milestone: milestone.id,
        phase: phase.id,
        stage: stageName,
        updated_at: now().toISOString(),
        ...extra,
      },
      narrative,
    );
    touchManifest(paths, () => {}, now);
  };

  markPhase('IN_PROGRESS');

  // ---- RESEARCH_DELTA (deterministic: only flag; agents re-research on demand elsewhere)
  stage('RESEARCH_DELTA', 'reutilizando pesquisa armazenada');

  // ---- SPEC_READY
  if (!exists(pp.spec)) {
    stage('SPEC_READY', 'gerando especificação da fase');
    const reqDoc = readRequirements(milestone.paths.requirements);
    const phaseReqs = reqDoc.requirements.filter((r) => r.phase === phase.id);
    const specTask: AgentTask = {
      id: `spec-${phase.id}`,
      role: 'planner',
      objective: `Write the SPEC.md for phase ${phase.id} (${phase.name}). It must be actionable, testable, tied to real code surfaces, complete and coherent, with observable acceptance scenarios for each requirement.`,
      canonical_files: [paths.rules, milestone.paths.scope, milestone.paths.requirements, milestone.paths.research].filter(exists),
      code_files: [],
      write_scope: [pp.spec.replace(/\\/g, '/')],
      acceptance_criteria: phaseReqs.map((r) => `${r.id}: ${r.acceptance}`),
      verification_commands: [],
      return_format: 'Write SPEC.md to disk; return a one-line confirmation.',
      notes: `Requirements in this phase:\n${phaseReqs.map((r) => `- ${r.id}: ${r.description}`).join('\n')}`,
    };
    const res = await runValidated(ctx.runner, specTask);
    if (!res.ok || !exists(pp.spec)) {
      return blocked(ctx, `Phase ${phase.id}: spec generation failed.`, [res.summary]);
    }
  } else {
    stage('SPEC_READY', 'especificação existente validada');
  }

  // ---- PLAN + PLAN_LINT + PLAN_REVIEW (bounded loop)
  const reqDoc = readRequirements(milestone.paths.requirements);
  const knownReqs = new Set(reqDoc.requirements.map((r) => r.id));
  let plan: PhasePlan | null = exists(pp.plan) ? readPlan(pp.plan) : null;
  let revisions = 0;
  let reviewNotes: string[] = [];
  while (true) {
    if (!plan) {
      stage('PLAN', `planejando tarefas (revisão ${revisions})`);
      const planTask: AgentTask = {
        id: `plan-${phase.id}-r${revisions}`,
        role: 'planner',
        objective: `Produce the execution plan for phase ${phase.id}: between 2 and 4 tasks, exact files or code regions, dependencies, per-worker write scope, tests and expected evidence, parallel flag only for independent tasks with disjoint write scopes. Set tdd=true for testable behavior.`,
        canonical_files: [paths.rules, pp.spec, milestone.paths.requirements].filter(exists),
        code_files: [],
        write_scope: [],
        acceptance_criteria: ['2-4 tasks', 'every task has requirement IDs or technical justification', 'write scopes are exact'],
        verification_commands: [],
        return_format:
          'JSON payload matching PhasePlan: {phase, tasks:[{id:"T01", name, requirement_ids[], technical_justification, files[], write_scope[], depends_on[], parallel, tdd, tests[], evidence_expected, done:false}]}',
        notes: reviewNotes.length ? `Previous review issues to address:\n${reviewNotes.join('\n')}` : '',
      };
      const res = await runValidated(ctx.runner, planTask);
      const parsed = PhasePlanSchema.safeParse(res.payload);
      if (!res.ok || !parsed.success) {
        return blocked(ctx, `Phase ${phase.id}: planning failed.`, [res.summary, ...(parsed.success ? [] : [parsed.error.message])]);
      }
      plan = parsed.data;
      plan.phase = phase.id;
      writePlan(pp.plan, plan, `Generated for ${phase.name}.`);
    }

    stage('PLAN_LINT', 'validação determinística do plano');
    const lintIssues = lintPlan(plan, { knownRequirements: knownReqs });
    if (lintIssues.length > 0) {
      if (revisions >= config.limits.plan_revisions) {
        return blocked(ctx, `Phase ${phase.id}: plan lint failed after ${revisions} revisions.`, lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`));
      }
      revisions++;
      reviewNotes = lintIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`);
      plan = null;
      continue;
    }

    stage('PLAN_REVIEW', 'revisão independente do plano');
    const reviewTask: AgentTask = {
      id: `plan-review-${phase.id}-r${revisions}`,
      role: 'reviewer',
      objective: `Independent brief review of the phase plan: completeness, coherence, risk, requirement coverage, adherence to rules. You receive spec and plan, never the author's reasoning.`,
      canonical_files: [paths.rules, pp.spec, pp.plan].filter(exists),
      code_files: [],
      write_scope: [],
      acceptance_criteria: [],
      verification_commands: [],
      return_format: 'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}',
      notes: '',
    };
    const reviewRes = await runValidated(ctx.runner, reviewTask);
    const review = ReviewPayloadSchema.safeParse(reviewRes.payload);
    if (!reviewRes.ok || !review.success) {
      return blocked(ctx, `Phase ${phase.id}: plan review failed to produce a verdict.`, [reviewRes.summary]);
    }
    if (review.data.approved) break;
    if (revisions >= config.limits.plan_revisions) {
      return blocked(
        ctx,
        `Phase ${phase.id}: plan not approved after ${config.limits.plan_revisions} revisions.`,
        review.data.findings.map((f) => `${f.type}/${f.severity}: ${f.description}`),
      );
    }
    revisions++;
    reviewNotes = review.data.findings.map((f) => `${f.type}: ${f.description}`);
    plan = null;
  }
  bus.emit('run.plan_approved', { message: 'plano aprovado' });

  // ---- EXECUTE (fresh worker per task; parallel only for disjoint scopes)
  const groups = parallelGroups(plan.tasks, config.limits.max_parallel_agents);
  const totalTasks = plan.tasks.length;
  for (const group of groups) {
    const pending = group.filter((t) => !readPlan(pp.plan).tasks.find((x) => x.id === t.id)?.done);
    if (pending.length === 0) continue;
    const tasks: AgentTask[] = pending.map((t) => ({
      id: `exec-${phase.id}-${t.id}`,
      role: 'worker',
      objective: `Implement task ${t.id}: ${t.name}. ${t.tdd ? 'Follow TDD: write a failing test (RED), implement (GREEN), refactor. ' : ''}Do not modify files outside your write scope; if you need to, stop and request a new allocation.`,
      canonical_files: [ctx.paths.rules, pp.spec, pp.plan].filter(exists),
      code_files: t.files,
      write_scope: t.write_scope,
      acceptance_criteria: [t.evidence_expected],
      verification_commands: t.tests,
      return_format: 'JSON payload: {done: boolean, notes: string}. Also list files_written.',
      notes: '',
    }));
    const taskIdx = plan.tasks.findIndex((t) => t.id === pending[0]!.id) + 1;
    stage('EXECUTE', `executando ${pending.map((t) => t.id).join('+')}`, {});
    bus.emit('run.task_start', {
      stage: 'EXECUTE',
      task: { id: pending[0]!.id, index: taskIdx, total: totalTasks, name: pending[0]!.name },
      agent: { role: 'worker', id: tasks[0]!.id },
      message: pending.map((t) => t.name).join(' | '),
    });
    const results = await runBatch(ctx.runner, tasks, config.limits.max_parallel_agents);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const t = pending[i]!;
      if (!r.ok) {
        return blocked(ctx, `Phase ${phase.id}: task ${t.id} failed.`, [r.summary, ...r.scope_requests.map((s) => `scope request: ${s}`)]);
      }
      markTaskDone(pp.plan, t.id);
      bus.emit('run.task_done', {
        completedUnits: readPlan(pp.plan).tasks.filter((x) => x.done).length,
        totalUnits: totalTasks,
        message: `tarefa ${t.id} concluída`,
      });
      checkpoint('EXECUTE', `Task ${t.id} of phase ${phase.id} verified by worker; plan checkbox flipped.`, { task: t.id });
    }
  }

  // ---- VERIFY + CODE_REVIEW loop (bounded)
  let reviewLoops = 0;
  let evidences: CommandEvidence[] = [];
  while (true) {
    stage('VERIFY', 'executando build, lint e testes direcionados');
    evidences = runVerification(ctx, plan);
    const failures = evidences.filter((e) => e.exit_code !== 0);
    if (failures.length > 0) {
      if (reviewLoops >= config.limits.qa_fix_loops) {
        return blocked(
          ctx,
          `Phase ${phase.id}: verification still failing after ${reviewLoops} repair attempts.`,
          failures.map((f) => `${f.command} → exit ${f.exit_code}\n${f.summary.slice(0, 400)}`),
        );
      }
      reviewLoops++;
      const fixTask: AgentTask = {
        id: `verify-fix-${phase.id}-l${reviewLoops}`,
        role: 'worker',
        objective: 'Fix the verification failures below with the smallest coherent change. Do not weaken tests to make them pass.',
        canonical_files: [pp.spec, pp.plan].filter(exists),
        code_files: plan.tasks.flatMap((t) => t.files),
        write_scope: plan.tasks.flatMap((t) => t.write_scope),
        acceptance_criteria: ['All verification commands exit 0'],
        verification_commands: failures.map((f) => f.command),
        return_format: 'JSON payload: {done: boolean, notes: string}',
        notes: failures.map((f) => `${f.command} → exit ${f.exit_code}\n${f.summary.slice(0, 800)}`).join('\n\n'),
      };
      const fixRes = await runValidated(ctx.runner, fixTask);
      if (!fixRes.ok) return blocked(ctx, `Phase ${phase.id}: repair worker failed.`, [fixRes.summary]);
      continue;
    }

    stage('CODE_REVIEW', 'revisão independente do código');
    const diffSummary = gitDiffSummary(ctx);
    const crTask: AgentTask = {
      id: `code-review-${phase.id}-l${reviewLoops}`,
      role: 'reviewer',
      objective:
        'Independent code review. You receive the spec, the plan, the diff and the verification evidence — never the implementer reasoning. Classify each finding as intent_gap, spec_gap, implementation_bug, test_gap, security_risk, quality_issue, defer or reject.',
      canonical_files: [pp.spec, pp.plan].filter(exists),
      code_files: plan.tasks.flatMap((t) => t.files),
      write_scope: [],
      acceptance_criteria: [],
      verification_commands: [],
      return_format: 'JSON payload: {approved: boolean, findings: [{type, severity, description, file}]}',
      notes: `DIFF SUMMARY:\n${diffSummary}\n\nEVIDENCE:\n${evidences.map((e) => `${e.command} → exit ${e.exit_code}`).join('\n')}`,
    };
    const crRes = await runValidated(ctx.runner, crTask);
    const cr = ReviewPayloadSchema.safeParse(crRes.payload);
    if (!crRes.ok || !cr.success) {
      return blocked(ctx, `Phase ${phase.id}: code review failed to produce a verdict.`, [crRes.summary]);
    }
    writeReviewDoc(pp, cr.data, reviewLoops, now);
    const specGaps = cr.data.findings.filter((f) => f.type === 'intent_gap' || f.type === 'spec_gap');
    if (specGaps.length > 0) {
      return blocked(
        ctx,
        `Phase ${phase.id}: review found spec/intent gaps; returning to specification instead of patching locally.`,
        specGaps.map((f) => `${f.type}: ${f.description}`),
      );
    }
    const actionable = cr.data.findings.filter((f) => !['defer', 'reject'].includes(f.type));
    if (cr.data.approved || actionable.length === 0) break;
    if (reviewLoops >= config.limits.review_loops) {
      return blocked(
        ctx,
        `Phase ${phase.id}: review findings persist after ${config.limits.review_loops} repair cycles.`,
        actionable.map((f) => `${f.type}/${f.severity}: ${f.description}`),
      );
    }
    reviewLoops++;
    const repairTask: AgentTask = {
      id: `review-fix-${phase.id}-l${reviewLoops}`,
      role: 'worker',
      objective: 'Address the valid review findings below with minimal coherent changes.',
      canonical_files: [pp.spec, pp.plan].filter(exists),
      code_files: plan.tasks.flatMap((t) => t.files),
      write_scope: plan.tasks.flatMap((t) => t.write_scope),
      acceptance_criteria: ['Findings addressed', 'Verification commands still pass'],
      verification_commands: [],
      return_format: 'JSON payload: {done: boolean, notes: string}',
      notes: actionable.map((f) => `${f.type}/${f.severity}: ${f.description}${f.file ? ` (${f.file})` : ''}`).join('\n'),
    };
    const repairRes = await runValidated(ctx.runner, repairTask);
    if (!repairRes.ok) return blocked(ctx, `Phase ${phase.id}: review repair failed.`, [repairRes.summary]);
  }

  // ---- UI_SMOKE (only for UI surfaces; honest about capability)
  let uiSmokeNote = 'not applicable (no UI surface in this phase)';
  if (phase.ui_surface) {
    if (!ctx.runner.capabilities.browser) {
      uiSmokeNote = 'SKIPPED: browser capability unavailable in this runtime (recorded, not simulated)';
      bus.emit('run.ui_smoke', { stage: 'UI_SMOKE', message: 'browser indisponível; smoke registrado como não executado' });
    } else {
      stage('UI_SMOKE', 'smoke visual da superfície alterada');
      const smokeTask: AgentTask = {
        id: `ui-smoke-${phase.id}`,
        role: 'qa',
        objective: 'UI smoke: load the changed surface, check console and network for errors, exercise the main navigation, capture a minimal screenshot.',
        canonical_files: [pp.spec].filter(exists),
        code_files: [],
        write_scope: [path.join(milestone.paths.qaDir, 'screenshots').replace(/\\/g, '/') + '/**'],
        acceptance_criteria: ['No unhandled console errors', 'No failing network requests on the main flow'],
        verification_commands: [],
        return_format: 'JSON payload: {passed, console_errors[], network_errors[], screenshot, notes}',
        notes: '',
      };
      const smokeRes = await runValidated(ctx.runner, smokeTask);
      const smoke = UiSmokePayloadSchema.safeParse(smokeRes.payload);
      if (!smokeRes.ok || !smoke.success || !smoke.data.passed) {
        return blocked(ctx, `Phase ${phase.id}: UI smoke failed.`, [
          smokeRes.summary,
          ...(smoke.success ? [...smoke.data.console_errors, ...smoke.data.network_errors] : []),
        ]);
      }
      uiSmokeNote = `passed${smoke.data.screenshot ? ` (screenshot: ${smoke.data.screenshot})` : ''}`;
    }
  }

  // ---- PERSIST (logical transaction: verification -> requirements -> roadmap -> state)
  stage('PERSIST', 'persistindo resumo, evidências e estado');
  const finalPlan = readPlan(pp.plan);
  writeFileAtomic(
    pp.verification,
    serializeFrontmatter(
      {
        phase: phase.id,
        verified_at: now().toISOString(),
        commands: evidences.map((e) => ({ command: e.command, exit_code: e.exit_code, duration_ms: e.duration_ms })),
        ui_smoke: uiSmokeNote,
        commit: null,
      },
      [
        `# Verification — phase ${phase.id}`,
        '',
        ...evidences.map((e) => `- \`${e.command}\` → exit ${e.exit_code}`),
        '',
        `UI smoke: ${uiSmokeNote}`,
        '',
      ].join('\n'),
    ),
  );
  writeFileAtomic(
    pp.summary,
    serializeFrontmatter(
      { phase: phase.id, completed_at: now().toISOString() },
      [
        `# Summary — phase ${phase.id} (${phase.name})`,
        '',
        ...finalPlan.tasks.map((t) => `- ${t.done ? '✔' : '✘'} ${t.id} ${t.name}`),
        '',
      ].join('\n'),
    ),
  );
  const reqDocFinal = readRequirements(milestone.paths.requirements);
  for (const r of reqDocFinal.requirements) {
    if (r.phase !== phase.id) continue;
    const tests = finalPlan.tasks.filter((t) => t.requirement_ids.includes(r.id)).flatMap((t) => t.tests);
    r.status = 'DONE';
    r.tests = tests;
    if (tests.length === 0 && !r.no_test_justification) {
      r.no_test_justification = 'Verified by phase verification commands (no dedicated test declared in plan).';
    }
    r.evidence = `VERIFICATION.md of phase ${phase.id} (${evidences.length} commands, all exit 0)`;
  }
  writeRequirements(milestone.paths.requirements, reqDocFinal);

  // ---- COMMIT
  let commitHash: string | null = null;
  if (config.git.commit && ctx.git.status(ctx.projectRoot).isRepo) {
    stage('COMMIT', 'criando commit atômico da fase verificada');
    commitHash = ctx.git.commitAll(ctx.projectRoot, `rijo(${milestone.id}-F${phase.id}): ${phase.name} verified`);
    if (commitHash) {
      const { data, body } = parseFrontmatter(readText(pp.verification));
      writeFileAtomic(pp.verification, serializeFrontmatter({ ...(data as Record<string, unknown>), commit: commitHash }, body));
    }
  }
  markPhase('DONE', commitHash);
  checkpoint('DONE', `Phase ${phase.id} (${phase.name}) verified and committed.`, {
    task: null,
    last_verified: `phase ${phase.id} @ ${now().toISOString()}`,
    last_commit: commitHash,
    next_step: 'rijo run (next phase) or rijo check',
  });

  bus.emit('run.phase_done', {
    status: 'running',
    stage: 'DONE',
    lastCheckpoint: commitHash ?? `phase-${phase.id}`,
    message: `fase ${phase.id} concluída${commitHash ? ` (commit ${commitHash.slice(0, 8)})` : ''}`,
  });
  return completed(ctx, `Phase ${phase.id} (${phase.name}) done${commitHash ? `, commit ${commitHash}` : ''}.`);
}

function runVerification(ctx: WorkflowContext, plan: PhasePlan): CommandEvidence[] {
  const commands = new Set<string>();
  for (const t of plan.tasks) for (const test of t.tests) commands.add(test);
  // detected project commands (build/typecheck/lint/test) — best effort
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
      for (const s of ['typecheck', 'lint', 'build', 'test']) {
        if (pkg.scripts?.[s]) commands.add(`npm run ${s}`);
      }
    } catch {
      /* unparseable package.json — plan tests only */
    }
  }
  const evidences: CommandEvidence[] = [];
  for (const cmd of commands) {
    const ev = ctx.shell.run(cmd, { cwd: ctx.projectRoot });
    evidences.push(ev);
    ctx.bus.emit('run.verify_command', { message: `${cmd} → exit ${ev.exit_code}` }, { command: cmd, exit: ev.exit_code });
  }
  return evidences;
}

function gitDiffSummary(ctx: WorkflowContext): string {
  const status = ctx.git.status(ctx.projectRoot);
  if (!status.isRepo) return 'no VCS';
  return status.dirtyFiles.length ? `changed files:\n${status.dirtyFiles.join('\n')}` : 'working tree clean (changes already committed per task)';
}

function writeReviewDoc(pp: PhasePaths, review: ReviewPayload, loop: number, now: () => Date): void {
  writeFileAtomic(
    pp.review,
    serializeFrontmatter(
      { approved: review.approved, loop, reviewed_at: now().toISOString(), findings: review.findings },
      [
        `# Review`,
        '',
        review.findings.length
          ? review.findings.map((f) => `- **${f.type}** (${f.severity}): ${f.description}${f.file ? ` — ${f.file}` : ''}`).join('\n')
          : 'No findings.',
        '',
      ].join('\n'),
    ),
  );
}
