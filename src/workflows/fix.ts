import * as path from 'node:path';
import { z } from 'zod';
import { exists, writeFileAtomic, readText } from '../core/fsx.js';
import { serializeFrontmatter, parseFrontmatter } from '../core/frontmatter.js';
import { snapshotFiles, diffSnapshots, pathInScope } from '../core/scope.js';
import type { AgentTaskDraft } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  dispatchReadOnly,
  dispatch,
  prepareAttempt,
  guardSchema,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';

export interface FixOptions {
  description: string;
  evidenceFiles?: string[];
}

const DiagnosisSchema = z.object({
  reproduced: z.boolean(),
  reproduction_steps: z.string().default(''),
  hypothesis: z.string().default(''),
  root_cause: z.string().nullable().default(null),
  escalate: z.boolean().default(false),
  escalate_reason: z.string().default(''),
});

const RepairSchema = z.object({
  fixed: z.boolean(),
  root_cause: z.string().default(''),
  change_summary: z.string().default(''),
  regression_test: z.string().nullable().default(null),
  regression_test_impossible_reason: z.string().nullable().default(null),
  verification_commands: z.array(z.string()).default([]),
  residual_risk: z.string().default('none identified'),
});

/**
 * rijo fix — quick correction flow. No formal phase planning; bounded at
 * config.limits.fix_attempts before escalating to a normal phase.
 */
export async function fixWorkflow(
  projectRoot: string,
  opts: FixOptions,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  const { paths, bus, config, now } = ctx;
  if (!exists(paths.manifest)) return failed(ctx, 'No RIJO project here. Run `rijo new @PLAN.md` first.');
  if (!opts.description.trim()) return failed(ctx, 'rijo fix requires a problem description.');
  const schemaGuard = guardSchema(ctx);
  if (schemaGuard) return schemaGuard;

  return withLock(ctx, async () => {
    const ts = now();
    const stamp = ts.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
    const slug = opts.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const fixPath = path.join(paths.fixesDir, `${stamp}-${slug || 'fix'}.md`);

    bus.emit('fix.start', { status: 'running', stage: 'REPRODUCE', message: `reproduzindo: ${opts.description.slice(0, 60)}` });
    writeFileAtomic(
      fixPath,
      serializeFrontmatter(
        { description: opts.description, status: 'IN_PROGRESS', created_at: ts.toISOString(), evidence_files: opts.evidenceFiles ?? [] },
        `# Fix — ${opts.description}\n\n## Log\n`,
      ),
    );
    const appendLog = (line: string) => {
      const current = readText(fixPath);
      writeFileAtomic(fixPath, `${current.trimEnd()}\n- ${now().toISOString()} ${line}\n`);
    };

    // ---- reproduce + diagnose (agent), bounded attempts
    let diagnosis: z.infer<typeof DiagnosisSchema> | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const diagTask: AgentTaskDraft = {
        id: `fix-diagnose-${attempt}`,
        role: 'lead',
        objective: `Reproduce this problem BEFORE editing anything, then identify the root cause: "${opts.description}". Formulate hypotheses and test the most likely one with evidence.`,
        canonical_files: [paths.rules, paths.state].filter(exists),
        code_files: opts.evidenceFiles ?? [],
        write_scope: [],
        acceptance_criteria: ['Problem reproduced or declared non-reproducible with the steps attempted'],
        verification_commands: [],
        return_format:
          'JSON payload: {reproduced, reproduction_steps, hypothesis, root_cause, escalate, escalate_reason}',
        notes: '',
      };
      const { result: res, violation } = await dispatchReadOnly(ctx, diagTask, { stage: 'DIAGNOSE' });
      if (violation.length > 0) {
        return blocked(ctx, 'Fix diagnosis (read-only) modified the checkout.', violation);
      }
      const parsed = DiagnosisSchema.safeParse(res.payload);
      if (!res.ok || !parsed.success) {
        appendLog(`diagnose attempt ${attempt} failed: ${res.summary}`);
        continue;
      }
      diagnosis = parsed.data;
      appendLog(`diagnose attempt ${attempt}: reproduced=${diagnosis.reproduced} cause=${diagnosis.root_cause ?? 'unknown'}`);
      if (diagnosis.reproduced || diagnosis.escalate) break;
    }
    if (!diagnosis || (!diagnosis.reproduced && !diagnosis.escalate)) {
      finalize(fixPath, 'ESCALATED', 'Problem could not be reproduced after 2 attempts; escalate to a normal phase (rijo run) with better evidence.', now);
      return blocked(ctx, 'Fix escalated: problem not reproduced after 2 attempts.', [
        'Escalation criteria met. Consider adding evidence (@log.txt, @evidence.png) or opening a phase.',
      ]);
    }
    if (diagnosis.escalate) {
      finalize(fixPath, 'ESCALATED', `Escalation: ${diagnosis.escalate_reason}`, now);
      return blocked(ctx, `Fix escalated: ${diagnosis.escalate_reason}`, [
        'Architectural change, dangerous migration, broad security impact or scope growth requires a normal phase.',
      ]);
    }

    // ---- repair (bounded by fix_attempts) with regression test
    bus.emit('fix.repair', { stage: 'REPAIR', message: 'aplicando a menor correção coerente' });
    // baseline before any edit, so the commit stages only what the fix changed
    const fixBaseline = snapshotFiles(projectRoot);
    let repair: z.infer<typeof RepairSchema> | null = null;
    for (let attempt = 1; attempt <= config.limits.fix_attempts; attempt++) {
      const repairTask: AgentTaskDraft = {
        id: `fix-repair-${attempt}`,
        role: 'worker',
        objective: `Apply the smallest coherent fix for the diagnosed root cause. Add a regression test when technically possible. Root cause: ${diagnosis.root_cause}. Reproduction: ${diagnosis.reproduction_steps}`,
        canonical_files: [paths.rules].filter(exists),
        code_files: opts.evidenceFiles ?? [],
        write_scope: ['**'],
        acceptance_criteria: ['Fix applied', 'Regression test added or impossibility justified'],
        verification_commands: [],
        return_format:
          'JSON payload: {fixed, root_cause, change_summary, regression_test, regression_test_impossible_reason, verification_commands[], residual_risk}',
        notes: '',
      };
      // Each repair attempt runs in its OWN isolated workspace; the patch is
      // verified INSIDE the workspace and only applied to the checkout after
      // every gate passes. A failed attempt is discarded whole.
      const attemptWs = prepareAttempt(ctx, repairTask);
      let applied = false;
      try {
        const res = await dispatch(ctx, attemptWs.task, { stage: 'REPAIR' });
        const parsed = RepairSchema.safeParse(res.payload);
        if (!res.ok || !parsed.success || !parsed.data.fixed) {
          appendLog(`repair attempt ${attempt} failed: ${res.summary}`);
          continue;
        }
        // Evidence gate: a fix must run at least one post-fix verification
        // command. A repair claiming success with zero commands is never accepted.
        if (parsed.data.verification_commands.length === 0) {
          appendLog(`repair attempt ${attempt}: rejected — no post-fix verification command (NO_VERIFICATION_EVIDENCE)`);
          continue;
        }
        const evidences = parsed.data.verification_commands.map((c) => ctx.shell.run(c, { cwd: attemptWs.workspace.root }));
        const policyBlocked = evidences.filter((e) => e.blocked);
        if (policyBlocked.length > 0) {
          appendLog(`repair attempt ${attempt}: verification command blocked by policy (${policyBlocked.map((e) => e.command).join(', ')})`);
          continue;
        }
        const failures = evidences.filter((e) => e.exit_code !== 0);
        if (failures.length > 0) {
          appendLog(`repair attempt ${attempt}: verification failed (${failures.map((f) => f.command).join(', ')})`);
          continue;
        }
        attemptWs.workspace.applyVerifiedPatch();
        applied = true;
        repair = parsed.data;
        appendLog(`repair attempt ${attempt}: verified in isolated workspace (${parsed.data.verification_commands.length} commands exit 0)`);
        break;
      } catch (err) {
        appendLog(`repair attempt ${attempt}: discarded — ${(err as Error).message}`);
        continue;
      } finally {
        attemptWs.workspace.discard();
        void applied;
      }
    }
    if (!repair) {
      finalize(fixPath, 'ESCALATED', `Fix not verified after ${config.limits.fix_attempts} attempts; escalate to a normal phase.`, now);
      return blocked(ctx, `Fix escalated after ${config.limits.fix_attempts} failed attempts.`, []);
    }

    // ---- closeout THEN commit, following the same two-commit model as run:
    // C1 contains the code changes + the fix record WITHOUT any self-hash;
    // C2 (evidence) only updates the record to point at C1 and is verified to
    // touch nothing else. No VCS → vcs: disabled and no hash is ever invented.
    const vcsEnabled = config.git.commit && ctx.git.status(projectRoot).isRepo;
    const buildRecord = (testedCommit: string | null, evidenceCommit: string | null) =>
      serializeFrontmatter(
        {
          ...(parseFrontmatter(readText(fixPath)).data as Record<string, unknown>),
          status: 'DONE',
          tested_commit: testedCommit,
          evidence_commit: evidenceCommit,
          vcs: vcsEnabled ? 'git' : 'disabled',
          closed_at: now().toISOString(),
        },
        [
          `# Fix — ${opts.description}`,
          '',
          `- Symptom: ${opts.description}`,
          `- Root cause: ${repair!.root_cause || diagnosis.root_cause}`,
          `- Fix: ${repair!.change_summary}`,
          `- Regression test: ${repair!.regression_test ?? `none (${repair!.regression_test_impossible_reason ?? 'not justified'})`}`,
          `- Evidence: ${repair!.verification_commands.map((c) => `\`${c}\` exit 0`).join(', ')}`,
          `- Residual risk: ${repair!.residual_risk}`,
          testedCommit ? `- Tested commit: ${testedCommit}` : '- Tested commit: no VCS (vcs: disabled)',
          '',
        ].join('\n'),
      );
    writeFileAtomic(fixPath, buildRecord(null, null));

    let commit: string | null = null;
    if (vcsEnabled) {
      // stage only the files the fix actually changed, plus the fix record —
      // never `git add -A`, so pre-existing user edits are not swept in.
      const changed = diffSnapshots(fixBaseline, snapshotFiles(projectRoot)).changed;
      const rel = path.relative(projectRoot, fixPath).split(path.sep).join('/');
      const toCommit = [...new Set([...changed.filter((p) => pathInScope(p, ['**'])), rel])];
      commit = ctx.git.commitPaths(projectRoot, `rijo(fix): ${slug || 'fix'} — ${repair.change_summary.slice(0, 60)}`, toCommit);
      if (!commit) {
        return blocked(ctx, 'Fix commit (C1) failed while git commits are enabled.', [
          'The verified fix is on disk but the commit did not complete.',
        ]);
      }
      writeFileAtomic(fixPath, buildRecord(commit, null));
      const evidenceCommit = ctx.git.commitPaths(projectRoot, `rijo(fix): evidence for ${commit.slice(0, 12)}`, [rel]);
      if (!evidenceCommit) {
        return blocked(ctx, 'Fix evidence commit (C2) failed.', [`Fix commit ${commit} exists but its evidence metadata is uncommitted.`]);
      }
      const rangeFiles = ctx.git.diffNames(projectRoot, commit, evidenceCommit);
      const illegal = rangeFiles.filter((f) => f !== rel);
      if (illegal.length > 0) {
        return blocked(ctx, 'Fix evidence commit touched non-evidence paths.', illegal);
      }
    }
    bus.emit('fix.done', { status: 'completed', message: `correção verificada${commit ? ` (commit ${commit.slice(0, 8)})` : ''}` });
    return completed(ctx, `Fix done: ${repair.change_summary}${commit ? ` (tested commit ${commit})` : ''}.`, [
      `Record: ${path.relative(projectRoot, fixPath)}`,
    ]);
  });
}

function finalize(fixPath: string, status: string, note: string, now: () => Date): void {
  const { data, body } = parseFrontmatter(readText(fixPath));
  writeFileAtomic(
    fixPath,
    serializeFrontmatter({ ...(data as Record<string, unknown>), status, closed_at: now().toISOString() }, `${body.trimEnd()}\n\n${note}\n`),
  );
}
