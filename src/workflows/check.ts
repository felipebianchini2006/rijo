import * as path from 'node:path';
import { exists, readText, writeFileAtomic } from '../core/fsx.js';
import { serializeFrontmatter, parseFrontmatter } from '../core/frontmatter.js';
import { activeMilestone, type MilestoneRef } from '../core/milestones.js';
import { readRequirements } from '../core/roadmap.js';
import { snapshotFiles, diffSnapshots } from '../core/scope.js';
import type { CommandEvidence } from '../core/commands.js';
import { deriveJourneys, loadJourneyActions, JourneyResultSchema, type Journey, type JourneyAction, type JourneyResult } from '../qa/journeys.js';
import { generatePlaywrightSpecs } from '../qa/playwright.js';
import { decideReadiness } from '../qa/readiness.js';
import { runProductionGate, type GateReport } from '../qa/gate.js';
import type { AgentTaskDraft } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  dispatch,
  dispatchBatch,
  commitDecisionProposals,
  discardDecisionProposals,
  prepareAttempt,
  guardSchema,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';

export interface CheckOptions {
  fix?: boolean;
  production?: boolean;
}

/**
 * rijo check — "test everything" and produce a production-readiness decision.
 * Never deploys. READY only when every gate passes; BLOCKED when an
 * indispensable capability is missing.
 */
export async function checkWorkflow(
  projectRoot: string,
  opts: CheckOptions = {},
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  const { paths, bus, config, now } = ctx;
  if (!exists(paths.manifest)) return failed(ctx, 'No RIJO project here. Run `rijo new @PLAN.md` first.');
  const schemaGuard = guardSchema(ctx);
  if (schemaGuard) return schemaGuard;
  const milestone = activeMilestone(paths);
  if (!milestone) return failed(ctx, 'No active milestone.');

  return withLock(ctx, async () => {
    // ---- 1: pin commit and environment
    const commit = ctx.git.headCommit(projectRoot);
    const environment = opts.production ? 'production-candidate' : 'local';
    bus.emit('check.start', {
      status: 'running',
      stage: 'CHECKS',
      milestone: { id: milestone.id, name: milestone.slug },
      message: `avaliando commit ${commit?.slice(0, 8) ?? 'sem VCS'} (${environment})`,
    });

    // ---- PRODUCTION GATE: executable verification of the exact commit.
    if (opts.production) {
      return productionCheck(ctx, milestone, opts);
    }

    // ---- 2-3: deterministic checks (only those that exist in the project)
    let checks = runDeterministicChecks(ctx);
    const hasBuild = detectHasBuild(ctx);
    const fixesApplied: string[] = [];
    bus.emit('check.deterministic', { message: `${checks.length} verificações, ${checks.filter((c) => c.exit_code !== 0).length} falhas` });

    // ---- 4-6: journeys derived from requirements
    const reqDoc = readRequirements(milestone.paths.requirements);
    const journeys = deriveJourneys(reqDoc.requirements);
    writeJourneysDoc(milestone.paths.qaDir, journeys, now);
    // Playwright specs: deterministic codegen from structured actions only —
    // a journey without an actions file gets NO spec (never a placeholder).
    const acceptanceById = Object.fromEntries(reqDoc.requirements.map((r) => [r.id, r.acceptance]));
    const actionsByJourney: Record<string, JourneyAction[]> = {};
    for (const j of journeys) {
      const a = loadJourneyActions(milestone.paths.qaDir, j.id);
      if (a) actionsByJourney[j.id] = a.actions;
    }
    const specs = generatePlaywrightSpecs(
      journeys,
      path.join(milestone.paths.qaDir, 'journeys'),
      config.qa.base_url,
      acceptanceById,
      actionsByJourney,
    );
    bus.emit('check.playwright', {
      message: `${specs.length}/${journeys.length} specs Playwright gerados (jornadas sem ações estruturadas não geram spec)`,
    });

    // ---- 7-9: browser journeys (isolated agents), honest about capability
    const missingCapabilities: string[] = [];
    let journeyResults: JourneyResult[] = [];
    if (!ctx.runner.capabilities.browser) {
      missingCapabilities.push('browser (Playwright-capable QA runtime)');
      bus.emit('check.journeys', { stage: 'JOURNEYS', message: 'browser indisponível: jornadas não executadas (BLOCKED)' });
    } else {
      bus.emit('check.journeys', { stage: 'JOURNEYS', message: `executando ${journeys.length} jornadas em agentes isolados` });
      journeyResults = await runJourneys(ctx, milestone.paths.qaDir, journeys);

      // ---- 12: --fix loop (bounded). After each repair the WHOLE matrix is
      // re-run — deterministic checks (build/lint/typecheck/test) AND the
      // failing journeys — so READY reflects the repaired state, not the old one.
      if (opts.fix) {
        for (let round = 1; round <= config.limits.qa_fix_loops; round++) {
          const failingJourneys = journeyResults.filter((r) => !r.passed);
          const failingChecks = checks.filter((c) => c.exit_code !== 0);
          if (failingJourneys.length === 0 && failingChecks.length === 0) break;
          bus.emit('check.fix', { stage: 'REPAIR', message: `rodada ${round}: corrigindo por causa raiz` });
          const fixTask: AgentTaskDraft = {
            id: `check-fix-${round}`,
            role: 'worker',
            objective: 'Group the failing checks and journey findings by root cause and fix them in limited scope. Do not fix symptoms individually when one cause explains several failures.',
            canonical_files: [paths.rules].filter(exists),
            code_files: [],
            write_scope: ['**'],
            acceptance_criteria: ['Failing journeys and checks pass on re-run'],
            verification_commands: [],
            return_format: 'JSON payload: {done: boolean, notes: string}',
            notes: [
              ...failingChecks.map((c) => `check ${c.command} → exit ${c.exit_code}`),
              ...failingJourneys.map((f) => `${f.journey_id}: ${f.findings.map((x) => `${x.severity} ${x.description}`).join('; ')}`),
            ].join('\n'),
          };
          const fixRes = await dispatch(ctx, fixTask, { stage: 'EXECUTE' });
          if (!fixRes.ok) break;
          commitDecisionProposals(ctx, fixRes);
          fixesApplied.push(`round ${round}: ${fixRes.summary}`);
          // re-run the entire deterministic matrix, not only the failing subset
          checks = runDeterministicChecks(ctx);
          const rerun = await runJourneys(ctx, milestone.paths.qaDir, journeys.filter((j) => failingJourneys.some((f) => f.journey_id === j.id)));
          journeyResults = journeyResults.map((r) => rerun.find((x) => x.journey_id === r.journey_id) ?? r);
        }
      }

      // ---- 10: independent visual review
      bus.emit('check.visual', { stage: 'REPORT', message: 'revisão visual independente' });
      const visualTask: AgentTaskDraft = {
        id: 'check-visual',
        role: 'reviewer',
        objective:
          'Independent visual review of the executed journeys: misalignment, overflow, clipping, contrast, density, hierarchy, typography, component inconsistency, interaction feedback, responsiveness. Semantic evaluation, not pixel comparison.',
        canonical_files: [],
        code_files: journeyResults.flatMap((r) => r.screenshots),
        write_scope: [],
        acceptance_criteria: [],
        verification_commands: [],
        return_format: 'JSON payload: {findings: [{severity, description, evidence}]}',
        notes: '',
      };
      const visualRes = await dispatch(ctx, visualTask, { stage: 'CODE_REVIEW', authorProfiles: ['senior-software-engineer'] });
      if (visualRes.ok && visualRes.payload) {
        const parsed = JourneyResultSchema.pick({ findings: true }).safeParse(visualRes.payload);
        if (parsed.success && journeyResults.length > 0) {
          journeyResults[0]!.findings.push(...parsed.data.findings);
          commitDecisionProposals(ctx, visualRes);
        }
      }
    }

    // The report must reference the exact state it tested. If --fix modified the
    // working tree, that state is uncommitted and cannot be certified until the
    // changes are committed and check is re-run against a clean commit.
    const finalStatus = ctx.git.status(projectRoot);
    const dirtyAfterFix = fixesApplied.length > 0 && finalStatus.isRepo && finalStatus.dirtyFiles.length > 0;

    // ---- 13-15: readiness decision and report
    const decision = decideReadiness({
      commit,
      environment,
      deterministicChecks: checks,
      requirements: reqDoc.requirements,
      journeys,
      journeyResults,
      missingCapabilities,
      fixesApplied,
      hasBuild,
      firstVersion: true,
    });
    if (dirtyAfterFix && decision.status === 'READY') {
      decision.status = 'NOT_READY';
      decision.reasons = [
        'Working tree was modified by --fix but not committed; commit the fixes and re-run `rijo check` to certify a clean commit.',
      ];
    }
    writeFileAtomic(
      milestone.paths.readiness,
      serializeFrontmatter(
        {
          status: decision.status,
          commit,
          environment,
          checked_at: now().toISOString(),
          commands: checks.map((c) => ({ command: c.command, exit_code: c.exit_code, blocked: c.blocked })),
          journeys_executed: journeyResults.map((r) => ({ id: r.journey_id, passed: r.passed })),
          missing_capabilities: missingCapabilities,
          fixes_applied: fixesApplied,
        },
        [
          `# Production readiness — ${milestone.id}`,
          '',
          `Status: **${decision.status}**`,
          `Commit: \`${commit ?? 'no VCS'}\` · Environment: ${environment} · Date: ${now().toISOString()}`,
          '',
          '## Gates',
          ...decision.reasons.map((r) => `- ${r}`),
          '',
          '## Deterministic checks',
          ...checks.map((c) => `- \`${c.command}\` → exit ${c.exit_code}`),
          '',
          '## Journeys',
          ...(journeys.length
            ? journeys.map((j) => {
                const r = journeyResults.find((x) => x.journey_id === j.id);
                return `- ${j.id} (${j.requirement_ids.join(', ')}): ${r ? (r.passed ? 'PASSED' : 'FAILED') : 'NOT EXECUTED'}`;
              })
            : ['- none derived']),
          '',
          '## Findings by severity',
          ...renderFindings(journeyResults),
          '',
          '## Unavailable capabilities',
          ...(missingCapabilities.length ? missingCapabilities.map((c) => `- ${c}`) : ['- none']),
          '',
        ].join('\n'),
      ),
    );

    bus.emit('check.done', {
      status: decision.status === 'READY' ? 'completed' : 'blocked',
      stage: 'REPORT',
      message: `prontidão: ${decision.status}`,
    });
    const details = [`Report: ${path.relative(projectRoot, milestone.paths.readiness)}`, ...decision.reasons.slice(0, 10)];
    if (decision.status === 'READY') return completed(ctx, `Production readiness: READY (commit ${commit?.slice(0, 8) ?? 'n/a'}).`, details);
    return {
      ok: false,
      status: 'blocked' as const,
      message: `Production readiness: ${decision.status}.`,
      details,
    };
  });
}

/**
 * `check --production`: the gate is EXECUTABLE verification of the exact
 * commit — clean checkout, reproducible install, real server, real Playwright
 * on every configured browser/viewport, evidence on failure. After --fix the
 * WHOLE matrix re-runs on the new commit; any change during the gate
 * invalidates the round. READY demands: known HEAD, clean tree, every
 * deterministic check green, every journey passed (or explicitly waived in
 * versioned config), every active requirement DONE and journey-covered.
 */
async function productionCheck(
  ctx: WorkflowContext,
  milestone: MilestoneRef,
  opts: CheckOptions,
): Promise<WorkflowOutcome> {
  const { paths, bus, config, now, projectRoot } = ctx;
  const reqDoc = readRequirements(milestone.paths.requirements);
  const journeys = deriveJourneys(reqDoc.requirements);
  const acceptanceById = Object.fromEntries(reqDoc.requirements.map((r) => [r.id, r.acceptance]));
  const gateDeps = {
    projectRoot,
    git: ctx.git,
    shell: ctx.shell,
    config,
    qaDir: milestone.paths.qaDir,
    now,
    emit: (type: string, message: string) => void bus.emit(type, { message }),
  };

  const fixesApplied: string[] = [];
  let gate: GateReport = await runProductionGate(gateDeps, journeys, acceptanceById);

  // ---- bounded --fix loop: repair in an isolated workspace, commit, and
  // re-run the ENTIRE matrix (build, lint, typecheck, unit, E2E, all journeys)
  // against the NEW exact commit.
  let round = 0;
  while (opts.fix && gate.status === 'failed' && round < config.limits.qa_fix_loops) {
    round++;
    bus.emit('check.fix', { stage: 'REPAIR', message: `rodada ${round}: corrigindo por causa raiz e reexecutando a matriz inteira` });
    const fixTask: AgentTaskDraft = {
      id: `check-fix-${round}`,
      role: 'worker',
      objective:
        'Group the failing checks and journey findings by root cause and fix them with limited scope. Do not fix symptoms individually when one cause explains several failures. Work only inside your isolated workspace.',
      canonical_files: [paths.rules].filter(exists),
      code_files: [],
      write_scope: ['**'],
      acceptance_criteria: ['Failing journeys and checks pass on the full gate re-run'],
      verification_commands: [],
      return_format: 'JSON payload: {done: boolean, notes: string}',
      notes: gate.reasons.join('\n'),
    };
    const attempt = prepareAttempt(ctx, fixTask);
    let appliedPaths: string[] = [];
    try {
      const res = await dispatch(ctx, attempt.task, { stage: 'EXECUTE' });
      if (!res.ok) {
        bus.emit('check.fix_failed', { message: `reparo falhou: ${res.summary}` });
        break;
      }
      const beforeApply = snapshotFiles(projectRoot);
      attempt.workspace.applyVerifiedPatch();
      appliedPaths = diffSnapshots(beforeApply, snapshotFiles(projectRoot)).changed;
      commitDecisionProposals(ctx, res);
    } catch (err) {
      bus.emit('check.fix_failed', { message: `reparo descartado: ${(err as Error).message}` });
      break;
    } finally {
      attempt.workspace.discard();
    }
    if (appliedPaths.length === 0) break;
    const fixCommit = ctx.git.commitPaths(projectRoot, `rijo(check-fix): round ${round}`, appliedPaths);
    if (!fixCommit) {
      return blocked(ctx, 'check --fix: repair commit failed; the gate cannot certify an uncommitted tree.', appliedPaths);
    }
    fixesApplied.push(`round ${round}: commit ${fixCommit}`);
    gate = await runProductionGate(gateDeps, journeys, acceptanceById);
  }

  // ---- readiness decision
  const reasons: string[] = [];
  if (gate.status === 'blocked') {
    reasons.push(...gate.reasons);
  } else {
    const waived = new Map(config.qa.waivers.map((w) => [w.journey_id, w.reason]));
    for (const c of gate.commands.filter((c) => c.exit_code !== 0)) {
      reasons.push(`Check failed: ${c.command} (exit ${c.exit_code})`);
    }
    for (const j of gate.journeys) {
      if (j.passed === true) continue;
      const waiver = waived.get(j.id);
      if (waiver) {
        reasons.push(`WAIVED journey ${j.id} (${waiver}) — auditable, versioned in config`);
        continue;
      }
      reasons.push(`Journey ${j.id} ${j.passed === null ? 'not executed' : 'failed'}: ${j.failures.join('; ') || 'see evidence'}`);
    }
    // requirement gate: every active requirement DONE and journey-covered
    const active = reqDoc.requirements.filter((r) => r.status !== 'CANCELLED' && r.status !== 'CARRIED');
    for (const r of active) {
      if (!journeys.some((j) => j.requirement_ids.includes(r.id))) reasons.push(`Requirement not covered by any journey: ${r.id}`);
      if (r.status !== 'DONE' && r.status !== 'DEBT') reasons.push(`Requirement ${r.id} is ${r.status}, not DONE.`);
    }
  }
  const hardFailures = reasons.filter((r) => !r.startsWith('WAIVED'));
  const status = gate.status === 'blocked' ? 'BLOCKED' : hardFailures.length === 0 ? 'READY' : 'NOT_READY';

  // ---- report: tested_commit, evidence paths, tool versions, commands
  const writeReadiness = (evidenceCommit: string | null) =>
    writeFileAtomic(
      milestone.paths.readiness,
      serializeFrontmatter(
        {
          status,
          tested_commit: gate.tested_commit || null,
          evidence_commit: evidenceCommit,
          environment: 'production-candidate',
          checked_at: now().toISOString(),
          tool_versions: gate.tool_versions,
          commands: gate.commands.map((c) => ({ command: c.command, exit_code: c.exit_code, sandbox: c.sandbox ?? null })),
          journeys: gate.journeys.map((j) => ({ id: j.id, requirements: j.requirement_ids, passed: j.passed, spec: j.spec ? path.basename(j.spec) : null })),
          evidence_dir: gate.evidence_dir,
          server_log: gate.server_log,
          fixes_applied: fixesApplied,
          waivers: config.qa.waivers,
        },
        [
          `# Production readiness — ${milestone.id}`,
          '',
          `Status: **${status}**`,
          `Tested commit: \`${gate.tested_commit || 'n/a'}\` · Date: ${now().toISOString()}`,
          '',
          '## Gates',
          ...(reasons.length ? reasons.map((r) => `- ${r}`) : ['- All gates passed']),
          '',
          '## Commands (exact commit, isolated checkout)',
          ...gate.commands.map((c) => `- \`${c.command}\` → exit ${c.exit_code} [${c.sandbox ?? 'n/a'}]`),
          '',
          '## Journeys (requirement → journey → spec → result)',
          ...gate.journeys.map(
            (j) =>
              `- ${j.id} [${j.requirement_ids.join(', ')}] → ${j.spec ? path.basename(j.spec) : 'no spec'} → ${j.passed === true ? 'PASSED' : j.passed === false ? 'FAILED' : 'NOT EXECUTED'}${j.failures.length ? ` — ${j.failures.join('; ')}` : ''}`,
          ),
          '',
          '## Evidence',
          `- results/traces: ${gate.evidence_dir ?? 'n/a'}`,
          `- server log: ${gate.server_log ?? 'n/a'}`,
          '',
          '## Tool versions',
          ...Object.entries(gate.tool_versions).map(([k, v]) => `- ${k}: ${v}`),
          '',
        ].join('\n'),
      ),
    );
  writeReadiness(null);

  // evidence commit: the readiness report points at the tested commit; the
  // report itself lands in a separate, verified evidence-only commit.
  const relReadiness = path.relative(projectRoot, milestone.paths.readiness).split(path.sep).join('/');
  const relQaDir = path.relative(projectRoot, milestone.paths.qaDir).split(path.sep).join('/');
  let evidenceCommit: string | null = null;
  if (ctx.git.status(projectRoot).isRepo && config.git.commit) {
    // evidence commit: readiness report + the gate's captured evidence
    // (server log, traces, screenshots) — nothing else. A BLOCKED round is
    // evidence too: it is committed so it can never dirty the next round.
    const label = gate.tested_commit ? `for ${gate.tested_commit.slice(0, 12)}` : `(gate ${status})`;
    evidenceCommit = ctx.git.commitPaths(projectRoot, `rijo(check): readiness evidence ${label}`, [relReadiness, relQaDir]);
    if (evidenceCommit && gate.tested_commit) {
      const range = ctx.git.diffNames(projectRoot, gate.tested_commit, evidenceCommit);
      const illegal = range.filter((f) => f !== relReadiness && !f.startsWith(relQaDir));
      if (illegal.length > 0) {
        return blocked(ctx, 'Readiness evidence commit touched non-evidence paths.', illegal);
      }
      writeReadiness(evidenceCommit);
      ctx.git.commitPaths(projectRoot, `rijo(check): readiness evidence sealed`, [relReadiness]);
    }
  }

  bus.emit('check.done', {
    status: status === 'READY' ? 'completed' : 'blocked',
    stage: 'REPORT',
    message: `prontidão (production gate): ${status}`,
  });
  const details = [
    `Report: ${path.relative(projectRoot, milestone.paths.readiness)}`,
    `tested_commit: ${gate.tested_commit || 'n/a'}`,
    ...(evidenceCommit ? [`evidence_commit: ${evidenceCommit}`] : []),
    ...reasons.slice(0, 10),
  ];
  if (status === 'READY') {
    return completed(ctx, `Production readiness: READY (commit ${gate.tested_commit.slice(0, 8)}).`, details);
  }
  return { ok: false, status: 'blocked' as const, message: `Production readiness: ${status}.`, details };
}

function detectHasBuild(ctx: WorkflowContext): boolean {
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (!exists(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
    return Boolean(pkg.scripts?.['build']);
  } catch {
    return false;
  }
}

function runDeterministicChecks(ctx: WorkflowContext): CommandEvidence[] {
  const commands: string[] = [];
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
      // ordered: format, lint, typecheck, production build, tests, e2e, audit
      for (const s of ['format:check', 'lint', 'typecheck', 'build', 'test', 'test:integration', 'test:e2e']) {
        if (pkg.scripts?.[s]) commands.push(`npm run ${s}`);
      }
      // Real Playwright execution when the project actually declares it and a
      // config exists — the generated specs are run, not just written.
      const hasPlaywright = Boolean(pkg.devDependencies?.['@playwright/test'] || pkg.dependencies?.['@playwright/test']);
      const hasConfig = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].some((f) => exists(path.join(ctx.projectRoot, f)));
      if (hasPlaywright && hasConfig && ctx.runner.capabilities.browser) {
        // locally installed binary (node_modules/.bin is on the reconstructed
        // PATH) — never npx, which could download an arbitrary package.
        commands.push('playwright test');
      }
      commands.push('npm audit --omit=dev --audit-level=high');
    } catch {
      /* no scripts detected */
    }
  }
  return commands.map((c) => {
    const ev = ctx.shell.run(c, { cwd: ctx.projectRoot });
    ctx.bus.emit('check.command', { message: `${c} → exit ${ev.exit_code}` }, { command: c, exit: ev.exit_code });
    return ev;
  });
}

async function runJourneys(ctx: WorkflowContext, qaDir: string, journeys: Journey[]): Promise<JourneyResult[]> {
  const tasks: AgentTaskDraft[] = journeys.map((j) => ({
    id: `journey-${j.id}`,
    role: 'qa',
    objective: [
      `Execute journey ${j.id} as a real user: enter the system, run the complete flow, click relevant actions, verify persistence and side effects.`,
      'Observe console, network (4xx/5xx), exceptions; verify loading/empty/success/error states; test permissions/roles when applicable; keyboard navigation on critical flows.',
      'Capture screenshot or trace on failure; record reproducible steps.',
      'Cover desktop, tablet and mobile on visual-priority flows.',
    ].join('\n'),
    canonical_files: [],
    code_files: [],
    write_scope: [qaDir.replace(/\\/g, '/') + '/**'],
    acceptance_criteria: j.requirement_ids,
    verification_commands: [],
    return_format:
      'JSON payload: {journey_id, passed, steps[], console_errors[], network_errors[], findings[{severity,description,evidence}], screenshots[]}',
    notes: `Requirements covered: ${j.requirement_ids.join(', ')}`,
  }));
  const results = await dispatchBatch(ctx, tasks, undefined, () => ({ stage: 'JOURNEYS' }));
  const out: JourneyResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const parsed = JourneyResultSchema.safeParse(r.payload);
    if (r.ok && parsed.success) commitDecisionProposals(ctx, r);
    else discardDecisionProposals(ctx, r);
    out.push(
      parsed.success
        ? parsed.data
        : {
            journey_id: journeys[i]!.id,
            passed: false,
            steps: [],
            console_errors: [],
            network_errors: [],
            findings: [{ severity: 'high', description: `Journey agent failed: ${r.summary}`, evidence: null }],
            screenshots: [],
          },
    );
  }
  return out;
}

function writeJourneysDoc(qaDir: string, journeys: Journey[], now: () => Date): void {
  writeFileAtomic(
    path.join(qaDir, 'journeys', 'JOURNEYS.md'),
    serializeFrontmatter(
      { derived_at: now().toISOString(), journeys },
      [
        '# QA journeys (derived from requirements)',
        '',
        ...journeys.map((j) => `- ${j.id}${j.critical ? ' [critical]' : ''}: ${j.name} → ${j.requirement_ids.join(', ')}`),
        '',
      ].join('\n'),
    ),
  );
}

function renderFindings(results: JourneyResult[]): string[] {
  const all = results.flatMap((r) => r.findings.map((f) => ({ ...f, journey: r.journey_id })));
  if (all.length === 0) return ['- none'];
  const order = ['blocker', 'critical', 'high', 'medium', 'low'];
  all.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  return all.map((f) => `- [${f.severity}] ${f.journey}: ${f.description}`);
}
