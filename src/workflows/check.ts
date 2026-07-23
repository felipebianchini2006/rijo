import * as path from 'node:path';
import { exists, readText, writeFileAtomic } from '../core/fsx.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { activeMilestone } from '../core/milestones.js';
import { readRequirements } from '../core/roadmap.js';
import type { CommandEvidence } from '../core/commands.js';
import { deriveJourneys, JourneyResultSchema, type Journey, type JourneyResult } from '../qa/journeys.js';
import { generatePlaywrightSpecs } from '../qa/playwright.js';
import { decideReadiness } from '../qa/readiness.js';
import { runBatch, runValidated } from '../agents/runner.js';
import type { AgentTask } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  completed,
  failed,
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

    // ---- 2-3: deterministic checks (only those that exist in the project)
    const checks = runDeterministicChecks(ctx);
    const failedChecks = checks.filter((c) => c.exit_code !== 0);
    bus.emit('check.deterministic', { message: `${checks.length} verificações, ${failedChecks.length} falhas` });

    // ---- 4-6: journeys derived from requirements
    const reqDoc = readRequirements(milestone.paths.requirements);
    const journeys = deriveJourneys(reqDoc.requirements);
    writeJourneysDoc(milestone.paths.qaDir, journeys, now);
    // Playwright specs: deterministic codegen, one per journey, run by QA agents or CI
    const specs = generatePlaywrightSpecs(journeys, path.join(milestone.paths.qaDir, 'journeys'));
    bus.emit('check.playwright', { message: `${specs.length} specs Playwright gerados em qa/journeys/` });

    // ---- 7-9: browser journeys (isolated agents), honest about capability
    const missingCapabilities: string[] = [];
    let journeyResults: JourneyResult[] = [];
    if (!ctx.runner.capabilities.browser) {
      missingCapabilities.push('browser (Playwright-capable QA runtime)');
      bus.emit('check.journeys', { stage: 'JOURNEYS', message: 'browser indisponível: jornadas não executadas (BLOCKED)' });
    } else {
      bus.emit('check.journeys', { stage: 'JOURNEYS', message: `executando ${journeys.length} jornadas em agentes isolados` });
      journeyResults = await runJourneys(ctx, milestone.paths.qaDir, journeys);

      // ---- 12: --fix loop (bounded)
      if (opts.fix) {
        for (let round = 1; round <= config.limits.qa_fix_loops; round++) {
          const failing = journeyResults.filter((r) => !r.passed);
          if (failing.length === 0) break;
          bus.emit('check.fix', { stage: 'REPAIR', message: `rodada ${round}: corrigindo ${failing.length} jornadas por causa raiz` });
          const fixTask: AgentTask = {
            id: `check-fix-${round}`,
            role: 'worker',
            objective: 'Group the failing journey findings by root cause and fix them in limited scope. Do not fix symptoms individually when one cause explains several failures.',
            canonical_files: [paths.rules].filter(exists),
            code_files: [],
            write_scope: ['**'],
            acceptance_criteria: ['Failing journeys pass on re-run'],
            verification_commands: [],
            return_format: 'JSON payload: {done: boolean, notes: string}',
            notes: failing
              .map((f) => `${f.journey_id}: ${f.findings.map((x) => `${x.severity} ${x.description}`).join('; ')}`)
              .join('\n'),
          };
          const fixRes = await runValidated(ctx.runner, fixTask);
          if (!fixRes.ok) break;
          const rerun = await runJourneys(ctx, milestone.paths.qaDir, journeys.filter((j) => failing.some((f) => f.journey_id === j.id)));
          journeyResults = journeyResults.map((r) => rerun.find((x) => x.journey_id === r.journey_id) ?? r);
        }
      }

      // ---- 10: independent visual review
      bus.emit('check.visual', { stage: 'REPORT', message: 'revisão visual independente' });
      const visualTask: AgentTask = {
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
      const visualRes = await runValidated(ctx.runner, visualTask);
      if (visualRes.ok && visualRes.payload) {
        const parsed = JourneyResultSchema.pick({ findings: true }).safeParse(visualRes.payload);
        if (parsed.success && journeyResults.length > 0) {
          journeyResults[0]!.findings.push(...parsed.data.findings);
        }
      }
    }

    // ---- 13-15: readiness decision and report
    const decision = decideReadiness({
      commit,
      environment,
      deterministicChecks: checks,
      requirements: reqDoc.requirements,
      journeys,
      journeyResults,
      missingCapabilities,
      fixesApplied: [],
    });
    writeFileAtomic(
      milestone.paths.readiness,
      serializeFrontmatter(
        {
          status: decision.status,
          commit,
          environment,
          checked_at: now().toISOString(),
          commands: checks.map((c) => ({ command: c.command, exit_code: c.exit_code })),
          journeys_executed: journeyResults.map((r) => ({ id: r.journey_id, passed: r.passed })),
          missing_capabilities: missingCapabilities,
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

function runDeterministicChecks(ctx: WorkflowContext): CommandEvidence[] {
  const commands: string[] = [];
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  if (exists(pkgPath)) {
    try {
      const pkg = JSON.parse(readText(pkgPath)) as { scripts?: Record<string, string> };
      // ordered: format, lint, typecheck, production build, tests, e2e, audit
      for (const s of ['format:check', 'lint', 'typecheck', 'build', 'test', 'test:integration', 'test:e2e']) {
        if (pkg.scripts?.[s]) commands.push(`npm run ${s}`);
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
  const tasks: AgentTask[] = journeys.map((j) => ({
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
  const results = await runBatch(ctx.runner, tasks, ctx.config.limits.max_parallel_agents);
  const out: JourneyResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const parsed = JourneyResultSchema.safeParse(r.payload);
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
