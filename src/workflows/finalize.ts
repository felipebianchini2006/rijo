import * as path from 'node:path';
import { exists, readText, writeFileAtomic } from '../core/fsx.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import { phasePaths, type PhasePaths } from '../core/paths.js';
import { readState, writeState, initialState } from '../core/state.js';
import { touchManifest } from '../core/manifest.js';
import { milestoneRef, type MilestoneRef } from '../core/milestones.js';
import { readRoadmap, writeRoadmap, readRequirements, writeRequirements } from '../core/roadmap.js';
import { readPlan, setTaskStatus } from '../core/plan.js';
import { diffSnapshots, pathInScope, snapshotFiles, type FileSnapshot } from '../core/scope.js';
import type { RoadmapPhase, PhasePlan } from '../core/schemas/index.js';
import type { CommandEvidence } from '../core/commands.js';
import {
  buildMarker,
  readFinalizeMarker,
  writeFinalizeMarker,
  removeFinalizeMarker,
  type FinalizeMarker,
} from '../core/finalize.js';
import {
  blocked,
  commitPortableDurableArtifacts,
  completed,
  type WorkflowContext,
  type WorkflowOutcome,
} from './shared.js';
import { markCodebasePathsStale } from '../codebase/state.js';
import { syncActiveProjectProjections } from './projections.js';

/**
 * Transactional, resumable phase finalization (P0.7).
 *
 * `stageFinalization` runs the FRESH pre-marker work (candidate artifacts +
 * the pre-existing-user-edit conflict check), writes the durable marker and
 * hands control to `runFinalization`. `reconcileFinalization` (invoked under
 * the runtime lock at startup, next to the other reconciliations) resumes an
 * interrupted finalization by re-running `runFinalization` from the marker.
 *
 * `runFinalization` is idempotent: every DONE-status write is re-derivable and
 * every commit is guarded by the marker's recorded hash (or adopted from HEAD
 * when a crash landed the commit but not the marker update). Because the marker
 * is written before any DONE status and removed only after the whole sequence
 * lands, a crash is always observable as a clean pre-finalization state (retry)
 * or a fully DONE-and-committed state — never a DONE phase without its commits.
 */

interface StageInput {
  milestone: MilestoneRef;
  phase: RoadmapPhase;
  pp: PhasePaths;
  plan: PhasePlan;
  evidences: CommandEvidence[];
  uiSmokeNote: string;
  /** Working-tree snapshot taken before any worker patch was applied. */
  phaseBaseline: FileSnapshot;
  /** Files already dirty before the phase ran — never appropriated into a commit. */
  dirtyAtStart: Set<string>;
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');

/** Write the candidate VERIFICATION.md (no commit hashes yet). */
function writeVerificationCandidate(
  pp: PhasePaths,
  phase: RoadmapPhase,
  evidences: CommandEvidence[],
  uiSmokeNote: string,
  vcsEnabled: boolean,
  now: () => Date,
): void {
  writeFileAtomic(
    pp.verification,
    serializeFrontmatter(
      {
        phase: phase.id,
        verified_at: now().toISOString(),
        commands: evidences.map((e) => ({ command: e.command, exit_code: e.exit_code, duration_ms: e.duration_ms })),
        ui_smoke: uiSmokeNote,
        tested_commit: null,
        evidence_commit: null,
        vcs: vcsEnabled ? 'git' : 'disabled',
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
}

/** Update only the commit-hash fields of VERIFICATION.md, preserving the body. */
function writeVerificationCommit(pp: PhasePaths, tested: string | null, evidence: string | null): void {
  const { data, body } = parseFrontmatter(readText(pp.verification));
  writeFileAtomic(
    pp.verification,
    serializeFrontmatter({ ...(data as Record<string, unknown>), tested_commit: tested, evidence_commit: evidence }, body),
  );
}

function writeSummary(pp: PhasePaths, phase: RoadmapPhase, plan: PhasePlan, now: () => Date): void {
  writeFileAtomic(
    pp.summary,
    serializeFrontmatter(
      { phase: phase.id, completed_at: now().toISOString() },
      [
        `# Summary — phase ${phase.id} (${phase.name})`,
        '',
        ...plan.tasks.map((t) => `- ${t.done ? '✔' : '✘'} ${t.id} ${t.name}`),
        '',
      ].join('\n'),
    ),
  );
}

/**
 * Requirement completion, derived entirely from on-disk state so it can be
 * replayed on resume: the command count comes from VERIFICATION.md, coverage
 * from the (already DONE) plan tasks. Idempotent.
 */
function applyRequirementCompletion(
  milestone: MilestoneRef,
  pp: PhasePaths,
  phase: RoadmapPhase,
  plan: PhasePlan,
): void {
  const vdata = parseFrontmatter(readText(pp.verification)).data as { commands?: unknown[] };
  const commandCount = Array.isArray(vdata.commands) ? vdata.commands.length : 0;
  const hadEvidence = commandCount > 0;
  const reqDoc = readRequirements(milestone.paths.requirements);
  for (const r of reqDoc.requirements) {
    if (r.phase !== phase.id) continue;
    const coveringTasks = plan.tasks.filter((t) => t.requirement_ids.includes(r.id) && t.status === 'DONE');
    if (coveringTasks.length === 0) {
      // Not implemented by any completed task — never silently mark DONE.
      r.status = 'BLOCKED';
      continue;
    }
    const tests = coveringTasks.flatMap((t) => t.tests);
    r.status = 'DONE';
    r.tests = tests;
    if (tests.length === 0 && !r.no_test_justification) {
      const waived = coveringTasks.every((t) => t.no_execution_justification);
      r.no_test_justification = waived
        ? `Non-executable work (waiver): ${coveringTasks.map((t) => t.no_execution_justification).join('; ')}`
        : 'Verified by phase verification commands (no dedicated test declared in plan).';
    }
    r.evidence = `VERIFICATION.md + REVIEW.md of phase ${phase.id} (${commandCount} commands${hadEvidence ? ', all exit 0' : ', waived'}; review approved)`;
  }
  writeRequirements(milestone.paths.requirements, reqDoc);
}

/**
 * Stage a fresh finalization: candidate artifacts, conflict check, durable
 * marker, then run it to completion (or a blocked outcome). Called by run.ts
 * once CODE_REVIEW has approved and tasks are VERIFIED.
 */
export async function stageFinalization(ctx: WorkflowContext, input: StageInput): Promise<WorkflowOutcome> {
  const { paths, config, now, projectRoot } = ctx;
  const { milestone, phase, pp, plan, evidences, uiSmokeNote, phaseBaseline, dirtyAtStart } = input;

  // Task-level DONE is part of the phase "code+state" committed in C1; it never
  // flips the ROADMAP/requirement status that resume keys off, so it is safe to
  // record before the marker (and makes the candidate SUMMARY honest).
  for (const t of readPlan(pp.plan).tasks) {
    if (t.status === 'VERIFIED') {
      ctx.bus.emit('task.transition', { message: `Task ${t.id} → DONE` }, { task: t.id, to: 'DONE' });
      setTaskStatus(pp.plan, t.id, 'DONE');
    }
  }

  const vcsEnabled = config.git.commit && ctx.git.status(projectRoot).isRepo;
  writeVerificationCandidate(pp, phase, evidences, uiSmokeNote, vcsEnabled, now);
  writeSummary(pp, phase, readPlan(pp.plan), now);

  // Decide the authorized source delta and the pre-existing-user-edit conflict
  // NOW, before any marker exists: a started finalization is always completable.
  let authorizedSource: string[] = [];
  if (vcsEnabled) {
    const sourceDelta = diffSnapshots(phaseBaseline, snapshotFiles(projectRoot));
    authorizedSource = sourceDelta.changed.filter((p) => plan.tasks.some((t) => pathInScope(p, t.write_scope)));
    const appropriated = authorizedSource.filter((p) => dirtyAtStart.has(p));
    if (appropriated.length > 0) {
      return blocked(ctx, `Phase ${phase.id}: files had pre-existing local changes before this phase ran.`, [
        `Conflicting paths: ${appropriated.join(', ')}`,
        'Commit or revert your local changes, then re-run the phase.',
      ]);
    }
  }

  const rijoArtifacts = [
    pp.research, pp.spec, pp.plan, pp.summary, pp.review, pp.verification,
    milestone.paths.requirements, milestone.paths.roadmap,
    paths.requirements, paths.roadmap, paths.events,
    paths.state, paths.manifest, paths.milestonesIndex, paths.stack, paths.decisions,
  ]
    .filter(exists)
    .map((p) => rel(projectRoot, p));
  const commitPaths = [...new Set([...authorizedSource, ...rijoArtifacts])];
  const allowedEvidencePaths = [
    pp.verification,
    milestone.paths.roadmap,
    paths.requirements,
    paths.roadmap,
    paths.events,
    paths.state,
    paths.manifest,
    paths.milestonesIndex,
  ]
    .filter(exists)
    .map((p) => rel(projectRoot, p));
  const sealPaths = [
    rel(projectRoot, pp.verification),
    rel(projectRoot, paths.events),
    rel(projectRoot, paths.manifest),
  ];

  const marker = buildMarker({
    milestone: milestone.id,
    phase: phase.id,
    phase_dir_rel: rel(projectRoot, pp.dir),
    vcs: vcsEnabled ? 'git' : 'disabled',
    commit_paths: commitPaths,
    allowed_evidence_paths: allowedEvidencePaths,
    seal_paths: sealPaths,
    authorized_source: authorizedSource,
    commit_message: `rijo(${milestone.id}-F${phase.id}): ${phase.name} verified`,
    created_at: now().toISOString(),
  });
  writeFinalizeMarker(paths, marker);
  ctx.finalizeHooks.afterStep?.('staged');

  return runFinalization(ctx, marker);
}

/**
 * Commit the given paths; on an empty commit, adopt HEAD only if its subject is
 * exactly the message we intended (a prior crash landed this very commit before
 * the marker recorded it). Returns null on a genuine failure.
 */
function commitOrAdopt(ctx: WorkflowContext, message: string, paths: string[]): string | null {
  const hash = ctx.git.commitPaths(ctx.projectRoot, message, paths);
  if (hash) return hash;
  if (ctx.git.headSubject(ctx.projectRoot) === message) return ctx.git.headCommit(ctx.projectRoot);
  return null;
}

/**
 * Drive a finalization from its marker to completion. Idempotent and safe to
 * call repeatedly (fresh or on resume). Removes the marker only after the full
 * sequence lands and the tree is clean.
 */
export async function runFinalization(ctx: WorkflowContext, marker: FinalizeMarker): Promise<WorkflowOutcome> {
  const { paths, bus, now, projectRoot } = ctx;
  const hooks = ctx.finalizeHooks;

  const milestone = milestoneRef(paths, marker.milestone);
  if (!milestone) {
    removeFinalizeMarker(paths);
    return blocked(ctx, `Finalization: milestone ${marker.milestone} is no longer in the manifest.`, []);
  }
  const roadmap = readRoadmap(milestone.paths.roadmap);
  const phase = roadmap.phases.find((p) => p.id === marker.phase);
  if (!phase) {
    removeFinalizeMarker(paths);
    return blocked(ctx, `Finalization: phase ${marker.phase} is no longer in the roadmap.`, []);
  }
  const pp = phasePaths(path.join(milestone.paths.phasesDir, `${phase.id}-${phase.slug}`));
  const vcsEnabled = marker.vcs === 'git';

  const phaseIndex = roadmap.phases.findIndex((p) => p.id === phase.id) + 1;
  const phaseInfo = { id: phase.id, index: phaseIndex, total: roadmap.phases.length, name: phase.name };
  const milestoneInfo = { id: milestone.id, name: milestone.slug };
  const emitStage = (s: import('../core/schemas/index.js').Stage, message: string): void => {
    bus.emit(`run.${s.toLowerCase()}`, { status: 'running', stage: s, milestone: milestoneInfo, phase: phaseInfo, message });
  };

  const markPhase = (status: RoadmapPhase['status'], commit?: string | null): void => {
    const doc = readRoadmap(milestone.paths.roadmap);
    const p = doc.phases.find((x) => x.id === phase.id)!;
    p.status = status;
    if (commit !== undefined) p.commit = commit;
    writeRoadmap(milestone.paths.roadmap, doc);
  };
  const checkpoint = (narrative: string, extra: Partial<import('../core/schemas/index.js').StateFrontmatter>): void => {
    const prev = readState(paths) ?? initialState(now);
    writeState(
      paths,
      { ...prev, milestone: milestone.id, phase: phase.id, stage: 'DONE', updated_at: now().toISOString(), ...extra },
      narrative,
    );
    touchManifest(paths, () => {}, now);
  };

  // A fully sealed finalization is complete on disk and in git; do not rewrite
  // anything (a wall-clock manifest touch would dirty the tree) — just finish.
  if (vcsEnabled && marker.sealed) {
    markCodebasePathsStale(paths, marker.authorized_source, `verified phase ${phase.id}`, now);
    removeFinalizeMarker(paths);
    return finishOutcome(ctx, phase, marker.tested_commit);
  }

  // ---- DONE-flips (idempotent). Observable requirement/roadmap/checkpoint DONE
  // is only made PERMANENT by the marker's removal at the very end.
  for (const t of readPlan(pp.plan).tasks) {
    if (t.status === 'VERIFIED') {
      bus.emit('task.transition', { message: `Task ${t.id} → DONE` }, { task: t.id, to: 'DONE' });
      setTaskStatus(pp.plan, t.id, 'DONE');
    }
  }
  applyRequirementCompletion(milestone, pp, phase, readPlan(pp.plan));
  markPhase('DONE', marker.tested_commit);
  syncActiveProjectProjections(paths);
  hooks.afterStep?.('roadmap');
  checkpoint(`Phase ${phase.id} (${phase.name}) verified.`, {
    task: null,
    last_verified: `phase ${phase.id} @ ${now().toISOString()}`,
    last_commit: marker.tested_commit,
    next_step: 'rijo run (next phase) or rijo check',
  });
  hooks.afterStep?.('state');

  if (!vcsEnabled) {
    // No VCS: DONE state on disk IS the completed form. Removal completes it.
    markCodebasePathsStale(paths, marker.authorized_source, `verified phase ${phase.id}`, now);
    removeFinalizeMarker(paths);
    return finishOutcome(ctx, phase, null);
  }

  emitStage('COMMIT', 'Commit the authorized files for the verified phase.');

  // ---- C1: code + phase state, no self-reference.
  let c1 = marker.tested_commit;
  if (c1 === null) {
    hooks.afterStep?.('before_c1');
    c1 = commitOrAdopt(ctx, marker.commit_message, marker.commit_paths);
    if (!c1) {
      return blocked(ctx, `Phase ${phase.id}: code commit (C1) failed while git commits are enabled.`, [
        'The verified artifacts are on disk but the phase commit did not complete.',
      ]);
    }
    marker.tested_commit = c1;
    marker.step = 'C1';
    writeFinalizeMarker(paths, marker);
    hooks.afterStep?.('after_c1');
  }

  // ---- Evidence metadata: point VERIFICATION/roadmap/state at C1.
  writeVerificationCommit(pp, c1, null);
  markPhase('DONE', c1);
  syncActiveProjectProjections(paths);
  checkpoint(`Phase ${phase.id} (${phase.name}) verified and committed.`, {
    task: null,
    last_verified: `phase ${phase.id} @ ${now().toISOString()}`,
    last_commit: c1,
    next_step: 'rijo run (next phase) or rijo check',
  });

  // ---- C2: evidence pointing at C1 — only allowed metadata paths may change.
  const c2Message = `rijo(${marker.milestone}-F${marker.phase}): evidence for ${c1.slice(0, 12)}`;
  let c2 = marker.evidence_commit;
  if (c2 === null) {
    hooks.afterStep?.('before_c2');
    c2 = commitOrAdopt(ctx, c2Message, marker.allowed_evidence_paths);
    if (!c2) {
      return blocked(ctx, `Phase ${phase.id}: evidence commit (C2) failed.`, [
        `Code commit ${c1} exists but its evidence metadata is uncommitted.`,
      ]);
    }
    marker.evidence_commit = c2;
    marker.step = 'C2';
    writeFinalizeMarker(paths, marker);
    hooks.afterStep?.('after_c2');
  }

  // ---- Deterministic check: C1..C2 contains ONLY allowed evidence metadata.
  const rangeFiles = ctx.git.diffNames(projectRoot, c1, c2);
  const illegal = rangeFiles.filter((f) => !marker.allowed_evidence_paths.includes(f));
  if (illegal.length > 0) {
    return blocked(ctx, `Phase ${phase.id}: evidence commit touched non-evidence paths.`, illegal);
  }

  // ---- Seal: record C2 inside VERIFICATION and commit the evidence metadata.
  if (!marker.sealed) {
    writeVerificationCommit(pp, c1, c2);
    touchManifest(paths, () => {}, now);
    hooks.afterStep?.('before_seal');
    const seal = commitOrAdopt(ctx, `rijo(${marker.milestone}-F${marker.phase}): evidence sealed`, marker.seal_paths);
    if (!seal) {
      return blocked(ctx, `Phase ${phase.id}: evidence seal commit failed.`, []);
    }
    marker.sealed = true;
    marker.step = 'SEALED';
    writeFinalizeMarker(paths, marker);
    hooks.afterStep?.('after_seal');
  }

  // ---- The tree must be clean: nothing RIJO touched may remain uncommitted.
  const endStatus = ctx.git.status(projectRoot);
  const rijoDirty = endStatus.dirtyFiles.filter(
    (f) => f.startsWith('.rijo/') || marker.commit_paths.includes(f) || marker.allowed_evidence_paths.includes(f),
  );
  if (rijoDirty.length > 0) {
    return blocked(ctx, `Phase ${phase.id}: tree not clean after commits.`, rijoDirty);
  }

  // ---- Completion: removing the marker is the single durable "done" signal.
  markCodebasePathsStale(paths, marker.authorized_source, `verified phase ${phase.id}`, now);
  removeFinalizeMarker(paths);
  return finishOutcome(ctx, phase, c1);
}

function finishOutcome(ctx: WorkflowContext, phase: RoadmapPhase, commitHash: string | null): WorkflowOutcome {
  ctx.bus.emit('run.phase_done', {
    status: 'running',
    stage: 'DONE',
    lastCheckpoint: commitHash ?? `phase-${phase.id}`,
    message: `Phase ${phase.id} completed${commitHash ? ` (commit ${commitHash.slice(0, 8)})` : ''}.`,
  });
  const outcome = completed(ctx, `Phase ${phase.id} (${phase.name}) done${commitHash ? `, commit ${commitHash}` : ''}.`);
  commitPortableDurableArtifacts(ctx, `phase ${phase.id} completed`);
  return outcome;
}

/**
 * Startup reconciliation for an interrupted finalization. A strict no-op when
 * no marker exists (so every existing workflow is unaffected). Invoked under
 * the runtime lock alongside the other reconciliations, before any workflow
 * body observes the phase state — so "the next execution resumes the
 * finalization from where it stopped" holds for every entry point.
 */
export async function reconcileFinalization(ctx: WorkflowContext): Promise<void> {
  const marker = readFinalizeMarker(ctx.paths);
  if (!marker) return;
  ctx.bus.emit(
    'finalization.resumed',
    { message: `Resume finalization for phase ${marker.phase} at step ${marker.step}.` },
    { phase: marker.phase, milestone: marker.milestone, step: marker.step },
  );
  const outcome = await runFinalization(ctx, marker);
  if (!outcome.ok) {
    ctx.bus.emit('finalization.blocked', { status: 'blocked', message: outcome.message }, { details: outcome.details ?? [] });
    throw new Error(`Finalization of phase ${marker.phase} could not complete: ${outcome.message}`);
  }
}
