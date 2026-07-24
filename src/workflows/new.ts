import * as path from 'node:path';
import { z } from 'zod';
import {
  ensureDir,
  exists,
  inventory,
  readText,
  readTextIfExists,
  writeFileAtomic,
} from '../core/fsx.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { milestonePaths } from '../core/paths.js';
import { defaultConfig, saveConfig } from '../core/config.js';
import { computeHashes, newManifest, readManifest, touchManifest, writeManifest, type HashOverlay } from '../core/manifest.js';
import { initialState, readState, renderState } from '../core/state.js';
import {
  activeMilestone,
  applySealDispositions,
  carryRequirement,
  createMilestone,
  nextMilestoneId,
  renderCloseout,
  renderMilestonesIndex,
  slugify,
  updateMilestonesIndex,
  validateSeal,
  type CarryoverItem,
  type MilestoneRef,
} from '../core/milestones.js';
import { MilestoneTransaction } from '../core/txn.js';
import { renderRequirements, renderRoadmap, readRequirements, readRoadmap } from '../core/roadmap.js';
import { validateTraceability } from '../core/traceability.js';
import { ManifestSchema, RequirementSchema, RoadmapPhaseSchema } from '../core/schemas/index.js';
import { ResearchStore } from '../research/cache.js';
import { renderBrief } from '../agents/prompts.js';
import { AgentTaskSchema, type AgentTaskDraft } from '../agents/protocol.js';
import { generateAdapters } from '../adapters/index.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  dispatch,
  dispatchBatch,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';
import { runCore } from './run.js';
import { uiCore } from './ui.js';

export interface NewOptions {
  planFile: string;
  next?: boolean;
  ui?: string;
  run?: boolean;
}

/** Structured payload the planner agent must return for plan extraction. */
export const PlanExtractionSchema = z.object({
  project_name: z.string(),
  project_summary: z.string(),
  stack_summary: z.string().default(''),
  rules: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
  requirements: z.array(
    z.object({
      description: z.string(),
      acceptance: z.string(),
      non_functional: z.boolean().default(false),
      classification: z
        .enum(['NEW', 'CHANGE', 'REMOVE', 'CARRYOVER', 'UNCHANGED_DEPENDENCY'])
        .default('NEW'),
    }),
  ),
  phases: z.array(
    z.object({
      name: z.string(),
      requirement_indexes: z.array(z.number().int()),
      depends_on_indexes: z.array(z.number().int()).default([]),
      ui_surface: z.boolean().default(false),
    }),
  ),
  research_topics: z
    .array(z.object({ key: z.string(), topic: z.string(), volatile: z.boolean().default(true) }))
    .default([]),
});
export type PlanExtraction = z.infer<typeof PlanExtractionSchema>;

interface BrownfieldInfo {
  isBrownfield: boolean;
  stackNotes: string[];
  baselineCommands: string[];
}

export async function newWorkflow(
  projectRoot: string,
  opts: NewOptions,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  const { paths, bus, config, now } = ctx;

  // ---- validation before acquiring anything
  const planPath = path.resolve(projectRoot, opts.planFile.replace(/^@/, ''));
  if (!exists(planPath)) {
    return failed(ctx, `Plan file not found: ${opts.planFile}`);
  }
  const hasRijo = exists(paths.manifest);
  if (hasRijo && !opts.next) {
    return blocked(
      ctx,
      'A RIJO project already exists here. Re-initialization is refused (non-destructive).',
      [`To start the next milestone run: rijo new @${path.basename(planPath)} --next`],
    );
  }
  if (!hasRijo && opts.next) {
    return failed(ctx, '--next requires an existing RIJO project; run rijo new without --next first.');
  }

  return withLock(ctx, async () => {
    bus.emit('new.start', { status: 'running', stage: 'ANALYZE', message: 'validando repositório e entrada' });

    // ---- git
    let gitStatus = ctx.git.status(projectRoot);
    if (!gitStatus.isRepo) {
      ctx.git.init(projectRoot);
      gitStatus = ctx.git.status(projectRoot);
    }

    // ---- milestone transition pre-checks (--next). The previous milestone is
    // NOT sealed here: sealing is deferred until the new plan has been
    // extracted and fully validated, so a planner or validation failure can
    // never corrupt the historic contract.
    const activePrev = opts.next ? activeMilestone(paths) : null;
    if (opts.next) {
      const prevState = readState(paths);
      if (prevState?.stage && prevState.stage !== 'DONE' && prevState.phase) {
        return blocked(ctx, 'An interrupted execution checkpoint exists.', [
          `Milestone ${prevState.milestone}, phase ${prevState.phase}, stage ${prevState.stage}.`,
          'Resume it with `rijo run` or resolve the checkpoint before starting the next milestone.',
        ]);
      }
      // A phase mid-flight (or blocked) in the active milestone also holds the
      // transition: STATE.md only records verified checkpoints, so the roadmap
      // is the authority for in-progress execution.
      if (activePrev && exists(activePrev.paths.roadmap)) {
        const openPhase = readRoadmap(activePrev.paths.roadmap).phases.find(
          (p) => p.status === 'IN_PROGRESS' || p.status === 'BLOCKED',
        );
        if (openPhase) {
          return blocked(ctx, 'An interrupted execution checkpoint exists.', [
            `Milestone ${activePrev.id}, phase ${openPhase.id} is ${openPhase.status}.`,
            'Resume it with `rijo run` or resolve the checkpoint before starting the next milestone.',
          ]);
        }
      }
      if (gitStatus.isRepo && gitStatus.dirtyFiles.length > 0) {
        return blocked(ctx, 'Unknown local changes present; they will never be discarded or stashed automatically.', [
          `Dirty files: ${gitStatus.dirtyFiles.slice(0, 20).join(', ')}`,
          'Commit or intentionally revert them, then re-run.',
        ]);
      }
    }

    // ---- brownfield detection
    const brown = detectBrownfield(ctx, hasRijo);
    if (brown.isBrownfield) {
      bus.emit('new.brownfield', { message: 'projeto brownfield detectado; mapeando convenções' }, { notes: brown.stackNotes });
    }

    // ---- read the plan and extract structure via planner agent
    bus.emit('new.analyze', { stage: 'ANALYZE', message: 'extraindo escopo e requisitos do plano' });
    const planContent = readText(planPath);
    const previousContext = opts.next ? summarizePreviousMilestones(ctx) : '';
    const extractTask: AgentTaskDraft = {
      id: 'new-extract',
      role: 'planner',
      objective:
        'Read the closed-scope development plan and extract: project identity, requirements (functional and non-functional) with acceptance scenarios, out-of-scope items, vertical-slice phases (each requirement mapped to exactly one phase), and research topics for volatile decisions.' +
        (opts.next
          ? ' This is a NEW MILESTONE on an existing product: classify each item as NEW, CHANGE, REMOVE, CARRYOVER or UNCHANGED_DEPENDENCY relative to the existing behavior described in the context.'
          : ''),
      canonical_files: [planPath],
      code_files: [],
      write_scope: [],
      acceptance_criteria: ['Every requirement has an acceptance scenario', 'No requirement is left without a phase'],
      verification_commands: [],
      return_format:
        'JSON payload matching the PlanExtraction schema: {project_name, project_summary, stack_summary, rules[], out_of_scope[], acceptance[], requirements[{description, acceptance, non_functional, classification}], phases[{name, requirement_indexes[], depends_on_indexes[], ui_surface}], research_topics[{key, topic, volatile}]}',
      notes: [previousContext, brown.stackNotes.join('\n')].filter(Boolean).join('\n\n') + `\n\nPLAN CONTENT:\n${planContent}`,
    };
    const extractResult = await dispatch(ctx, extractTask, { stage: 'PLAN' });
    if (!extractResult.ok || !extractResult.payload) {
      return blocked(ctx, 'Plan extraction failed.', [extractResult.summary, `Brief was:\n${renderBrief(AgentTaskSchema.parse(extractTask)).slice(0, 400)}…`]);
    }
    const parsed = PlanExtractionSchema.safeParse(extractResult.payload);
    if (!parsed.success) {
      return failed(ctx, 'Planner returned an invalid extraction payload.', [parsed.error.message]);
    }
    const extraction = parsed.data;

    // ---- STAGING: build the new milestone entirely in memory and validate it
    // BEFORE any durable mutation. The prospective ID is deterministic; sealing
    // and createMilestone happen only after validation passes.
    if (!hasRijo) {
      ensureDir(paths.root);
      ensureDir(paths.runtimeDir);
      ensureDir(paths.fixesDir);
      ensureDir(paths.importsDir);
      ensureDir(paths.archiveDir);
      ensureDir(paths.researchDir);
      // volatile internals never enter version control
      writeFileAtomic(path.join(paths.root, '.gitignore'), ['runtime/', 'events.jsonl', 'archive/', ''].join('\n'));
      saveConfig(paths, defaultConfig());
      writeManifest(paths, newManifest(now));
    }
    const newId = nextMilestoneId(readManifest(paths));

    let seq = 0;
    const requirements = extraction.requirements.map((r) =>
      RequirementSchema.parse({
        id: `${newId}-REQ-${String(++seq).padStart(3, '0')}`,
        description: r.description,
        acceptance: r.acceptance,
        phase: null,
        status: 'PENDING',
        classification: r.classification,
        carried_from: null,
      }),
    );
    // Carryover ONLY from the immediately-previous active milestone's unfinished
    // requirements. Each successor `resolves` its immediate predecessor, forming
    // a terminal chain: an original requirement is carried at most once (into the
    // very next milestone) and never re-carried from older history — because we
    // never scan beyond the immediate previous milestone.
    const carryoverItems: CarryoverItem[] = [];
    if (opts.next && activePrev && exists(activePrev.paths.requirements)) {
      const prevReqs = readRequirements(activePrev.paths.requirements).requirements;
      const undone = prevReqs.filter((r) => r.status !== 'DONE' && r.status !== 'CANCELLED');
      for (const item of undone) {
        const carried = carryRequirement(item, newId, ++seq);
        carried.resolves = item.id;
        requirements.push(carried);
        carryoverItems.push({ requirement: item, disposition: item.status === 'BLOCKED' ? 'blocked' : 'carried' });
      }
    }

    const phases = extraction.phases.map((p, i) =>
      RoadmapPhaseSchema.parse({
        id: String(i + 1).padStart(2, '0'),
        slug: slugName(p.name),
        name: p.name,
        depends_on: p.depends_on_indexes.map((d) => String(d + 1).padStart(2, '0')),
        requirements: [],
        status: 'PENDING',
        ui_surface: p.ui_surface,
      }),
    );
    extraction.phases.forEach((p, i) => {
      for (const ri of p.requirement_indexes) {
        const req = requirements[ri];
        if (req && !req.phase) {
          req.phase = phases[i]!.id;
          phases[i]!.requirements.push(req.id);
        }
      }
    });
    const decisions: string[] = [];
    for (const req of requirements) {
      if (!req.phase && phases.length > 0) {
        req.phase = phases[0]!.id;
        phases[0]!.requirements.push(req.id);
        decisions.push(`Assigned ${req.id} (${req.classification}) to phase 01 by conservative default.`);
      }
    }

    const traceIssues = validateTraceability({ requirements, phases });
    if (traceIssues.some((i) => i.severity === 'error')) {
      // Nothing durable was mutated for a --next transition: the previous
      // milestone and the active pointer are untouched.
      return failed(ctx, 'Traceability validation failed for the generated roadmap.', traceIssues.map((i) => `${i.code}: ${i.message} — ${i.fix}`));
    }

    // Deterministic identity of the milestone being created; nothing durable
    // outside the runtime dir changes until the transaction commit point.
    const newSlug = slugify(extraction.project_name);
    const newDir = paths.milestoneDir(newId, newSlug);
    const mp = milestonePaths(newDir);
    const milestone: MilestoneRef = { id: newId, slug: newSlug, dir: newDir, paths: mp };

    // ---- research (parallel on first milestone, delta afterwards)
    bus.emit('new.research', { stage: 'RESEARCH', message: 'pesquisa técnica (delta quando possível)' });
    const store = new ResearchStore(paths, now);
    const topics = extraction.research_topics.slice(0, 4);
    const toResearch = topics.filter((t) => !store.lookup(t.key));
    const cached = topics.filter((t) => store.lookup(t.key));
    let researchSummaries: string[] = cached.map((t) => `- ${t.topic}: (cache) ${store.lookup(t.key)!.summary}`);
    if (toResearch.length > 0) {
      const tasks: AgentTaskDraft[] = toResearch.map((t, i) => ({
        id: `new-research-${i + 1}`,
        role: 'researcher',
        objective: `Research: ${t.topic}. Prefer official docs, release/LTS pages, changelogs, security advisories, official registries. Never assume newest is best; weigh stability, support, security, compatibility, migration cost. Separate fact, inference and recommendation.`,
        canonical_files: [],
        code_files: [],
        write_scope: [],
        acceptance_criteria: ['Every volatile claim has source title, url, check date and version'],
        verification_commands: [],
        return_format:
          'JSON payload: {summary: string, sources: [{claim, source, url, checked_at, version, confidence, tier: official|advisory|secondary}]}. tier=official for official docs/registries, advisory for primary security advisories.',
        notes: '',
      }));
      const results = await dispatchBatch(ctx, tasks, undefined, () => ({ stage: 'RESEARCH' }));
      const waivers = new Map(config.research.waivers.map((w) => [w.key, w.reason]));
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const topic = toResearch[i]!;
        const waiver = waivers.get(topic.key);
        const failClosed = (reason: string): WorkflowOutcome | null => {
          if (!topic.volatile || !config.research.fail_closed) {
            decisions.push(`Research "${topic.topic}": ${reason}; recorded as an open gap (non-volatile or fail-closed disabled).`);
            return null;
          }
          if (waiver) {
            decisions.push(`Research waiver for "${topic.topic}" (${reason}). Auditable justification: ${waiver}`);
            return null;
          }
          return blocked(ctx, `Volatile research "${topic.topic}" failed closed: ${reason}.`, [
            'A volatile decision (stack, version, security, compatibility) requires an official source or primary advisory.',
            `Add sources, or record an auditable waiver in .rijo/config.yml (research.waivers: [{key: "${topic.key}", reason: "…"}]).`,
          ]);
        };
        if (!r.ok) {
          const out = failClosed('researcher failed to produce a result');
          if (out) return out;
          continue;
        }
        const payload = z
          .object({
            summary: z.string(),
            sources: z
              .array(
                z.object({
                  claim: z.string(),
                  source: z.string(),
                  url: z.string(),
                  checked_at: z.string().default(now().toISOString()),
                  version: z.string().nullable().default(null),
                  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
                  tier: z.enum(['official', 'advisory', 'secondary']).default('secondary'),
                }),
              )
              .default([]),
          })
          .safeParse(r.payload);
        if (!payload.success) {
          const out = failClosed('researcher returned an unparseable result');
          if (out) return out;
          continue;
        }
        for (const s of payload.data.sources) {
          store.addSource({ ...s, used_by: ['STACK.md', `${milestone.id}/RESEARCH.md`] });
        }
        store.store({
          key: topic.key,
          topic: topic.topic,
          summary: payload.data.summary,
          volatile: topic.volatile,
          sources: payload.data.sources.map((s) => s.url),
        });
        // Fail-closed rule on the main path: a volatile decision without a
        // fresh official/advisory source blocks (or requires an auditable
        // waiver) — lack of research is never converted into an assumption.
        if (topic.volatile) {
          const verdict = store.validateVolatileDecision(topic.topic, payload.data.sources.map((s) => s.url));
          if (!verdict.valid) {
            const out = failClosed(verdict.reason ?? 'no valid source');
            if (out) return out;
          }
        }
        researchSummaries.push(`- ${topic.topic}: ${payload.data.summary}`);
      }
      // long-project hygiene: keep sources.json bounded, archive the oldest
      const compacted = store.compactSources(config.research.max_sources);
      if (compacted.archived > 0) {
        bus.emit('research.compacted', { message: `${compacted.archived} fontes arquivadas em ${path.basename(compacted.archiveFile!)}` });
      }
    }

    // ---- build EVERY canonical artifact of the transition in memory
    bus.emit('new.persist', { stage: 'ROADMAP', message: 'gravando contexto canônico e roadmap' });
    const scopeContent = serializeFrontmatter(
      { milestone: milestone.id, source_plan: path.basename(planPath), created_at: now().toISOString() },
      [
        `# Scope — ${milestone.id}`,
        '',
        extraction.project_summary,
        '',
        '## Out of scope',
        ...(extraction.out_of_scope.length ? extraction.out_of_scope.map((o) => `- ${o}`) : ['- none declared']),
        '',
        '## Completion criteria',
        ...(extraction.acceptance.length ? extraction.acceptance.map((a) => `- ${a}`) : ['- all requirements verified']),
        '',
      ].join('\n'),
    );
    const requirementsContent = renderRequirements({ milestone: milestone.id, requirements });
    const roadmapContent = renderRoadmap({ milestone: milestone.id, phases });
    const researchContent = serializeFrontmatter(
      { milestone: milestone.id, updated_at: now().toISOString() },
      [`# Research — ${milestone.id}`, '', ...(researchSummaries.length ? researchSummaries : ['- no research topics required']), ''].join('\n'),
    );
    const stateContent = renderState(
      {
        ...initialState(now),
        milestone: milestone.id,
        next_step: opts.ui
          ? `rijo ui @${opts.ui.replace(/^@/, '')} (import scheduled) then rijo run`
          : 'rijo run',
        updated_at: now().toISOString(),
      },
      `Milestone ${milestone.id} created from ${path.basename(planPath)}. ${requirements.length} requirements across ${phases.length} phases.`,
    );
    const globals = buildGlobalArtifacts(ctx, extraction, brown, decisions);

    const relRoot = (p: string) => path.relative(projectRoot, p).split(path.sep).join('/');
    const relRijo = (p: string) => path.relative(paths.root, p).split(path.sep).join('/');

    if (opts.next && activePrev) {
      // ---- CRASH-SAFE TRANSACTION: seal the previous milestone and activate
      // the next one through a single atomic commit point. Nothing outside
      // .rijo/runtime changes before commitPoint(); after it, apply is
      // deterministic and idempotent (startup reconciliation rolls forward).
      const allDone = carryoverItems.length === 0;
      const sealInput = {
        status: (allDone ? 'COMPLETE' : 'PARTIAL') as 'COMPLETE' | 'PARTIAL',
        baselineCommit: ctx.git.headCommit(projectRoot),
        baselineBranch: gitStatus.branch,
        deliveredVersion: null,
        carryover: carryoverItems,
        evidence: [],
        residualRisks: [],
        productionState: 'see qa/production-readiness.md if present',
      };
      const prevReqDoc = exists(activePrev.paths.requirements) ? readRequirements(activePrev.paths.requirements) : null;
      try {
        validateSeal(activePrev, sealInput, prevReqDoc);
      } catch (err) {
        return failed(ctx, `Milestone ${activePrev.id} cannot be sealed.`, [(err as Error).message]);
      }
      const sealedReqDoc = prevReqDoc ? applySealDispositions(prevReqDoc, carryoverItems) : null;
      const closeoutContent = renderCloseout(activePrev, sealInput, sealedReqDoc, now);

      const manifest = readManifest(paths)!;
      const prevEntry = manifest.milestones.find((m) => m.id === activePrev.id);
      if (prevEntry) prevEntry.status = sealInput.status;
      manifest.milestones.push({ id: newId, slug: newSlug, status: 'ACTIVE' });
      manifest.active_milestone = newId;
      manifest.updated_at = now().toISOString();
      const indexContent = renderMilestonesIndex(paths, manifest, now, new Map([[activePrev.id, closeoutContent]]));

      const overlay: HashOverlay = new Map<string, string>([
        [relRijo(activePrev.paths.closeout), closeoutContent],
        [relRijo(mp.scope), scopeContent],
        [relRijo(mp.requirements), requirementsContent],
        [relRijo(mp.roadmap), roadmapContent],
        [relRijo(mp.research), researchContent],
        ['STATE.md', stateContent],
        ['MILESTONES.md', indexContent],
        ['manifest.json', JSON.stringify(manifest)],
      ]);
      if (sealedReqDoc) overlay.set(relRijo(activePrev.paths.requirements), renderRequirements(sealedReqDoc));
      for (const g of globals) overlay.set(relRijo(g.path), g.content);
      manifest.hashes = computeHashes(paths, overlay);
      const manifestContent = JSON.stringify(ManifestSchema.parse(manifest), null, 2) + '\n';

      const tx = MilestoneTransaction.begin(paths, { kind: 'milestone-next', prev: activePrev.id, next: newId }, deps.txnHooks ?? {}, now);
      tx.stageDir(relRoot(mp.phasesDir));
      tx.stageDir(relRoot(path.join(mp.qaDir, 'journeys')));
      tx.stageDir(relRoot(path.join(mp.qaDir, 'screenshots')));
      tx.stageDir(relRoot(path.join(mp.qaDir, 'traces')));
      tx.stage(relRoot(activePrev.paths.closeout), closeoutContent);
      if (sealedReqDoc) tx.stage(relRoot(activePrev.paths.requirements), renderRequirements(sealedReqDoc));
      tx.stage(relRoot(mp.scope), scopeContent);
      tx.stage(relRoot(mp.requirements), requirementsContent);
      tx.stage(relRoot(mp.roadmap), roadmapContent);
      tx.stage(relRoot(mp.research), researchContent);
      for (const g of globals) tx.stage(relRoot(g.path), g.content);
      tx.stage(relRoot(paths.state), stateContent);
      tx.stage(relRoot(paths.milestonesIndex), indexContent);
      tx.stage(relRoot(paths.manifest), manifestContent);
      tx.commitPoint();
      tx.apply();
      tx.finish();

      if (config.git.tag_milestones && gitStatus.isRepo) {
        ctx.git.tag(projectRoot, `rijo/${activePrev.id}`, `RIJO milestone ${activePrev.id} sealed`);
      }
      bus.emit('milestone.sealed', { message: `milestone ${activePrev.id} selado (${allDone ? 'COMPLETE' : 'PARTIAL'})` }, { milestone: activePrev.id });
    } else {
      // ---- first milestone: direct creation (there is no previous state a
      // crash could corrupt; a partial init is recreated by re-running new).
      const created = createMilestone(paths, extraction.project_name, now);
      if (created.id !== newId) {
        return failed(ctx, 'Milestone ID drift during creation.', [`expected ${newId}, got ${created.id}`]);
      }
      for (const g of globals) writeFileAtomic(g.path, g.content);
      writeFileAtomic(mp.scope, scopeContent);
      writeFileAtomic(mp.requirements, requirementsContent);
      writeFileAtomic(mp.roadmap, roadmapContent);
      writeFileAtomic(mp.research, researchContent);
      writeFileAtomic(paths.state, stateContent);
      touchManifest(paths, () => {}, now);
      updateMilestonesIndex(paths, now);
    }

    // ---- adapters
    const adapterReport = generateAdapters(projectRoot);
    bus.emit('new.adapters', { message: `adapters gerados: ${adapterReport.generated.join(', ') || 'nenhum'}` });

    // ---- baseline commit: the canonical context and generated adapters are
    // committed so the milestone starts from a clean, known tree. Only paths
    // RIJO itself created are staged — user files (including the plan) are
    // never swept in.
    if (config.git.commit && ctx.git.status(projectRoot).isRepo) {
      const rijoRel = path.relative(projectRoot, paths.root).split(path.sep).join('/');
      const adapterPaths = adapterReport.generated
        .map((g) => g.split(' ')[0]!)
        .filter((g) => exists(path.resolve(projectRoot, g)));
      const baselineCommit = ctx.git.commitPaths(
        projectRoot,
        `rijo(${milestone.id}): milestone initialized`,
        [rijoRel, ...adapterPaths],
      );
      if (!baselineCommit) {
        return blocked(ctx, `Milestone ${milestone.id}: baseline commit failed while git commits are enabled.`, [
          'The canonical artifacts are on disk but the initialization commit did not complete.',
        ]);
      }
    }

    bus.emit(
      'new.done',
      {
        status: 'completed',
        milestone: { id: milestone.id, name: extraction.project_name },
        message: `milestone ${milestone.id} pronto: ${requirements.length} requisitos, ${phases.length} fases`,
      },
      { requirements: requirements.length, phases: phases.length },
    );

    // ---- composition new → ui → run, all under this single lock/context.
    if (opts.ui) {
      bus.emit('new.ui', { stage: 'IMPORT', message: `importando design ${opts.ui}` });
      const uiOutcome = await uiCore(ctx, { input: opts.ui });
      if (!uiOutcome.ok) return uiOutcome;
    }
    if (opts.run) {
      return runCore(ctx, { target: 'all' });
    }
    return completed(ctx, `Milestone ${milestone.id} created (${requirements.length} requirements, ${phases.length} phases).`);
  });
}

function detectBrownfield(ctx: { projectRoot: string }, hasRijo: boolean): BrownfieldInfo {
  const inv = inventory(ctx.projectRoot, { skipDirs: ['node_modules', '.git', 'dist', '.rijo', '.next', 'coverage'] });
  const codeFiles = inv.filter((f) => /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs)$/.test(f.relPath));
  const isBrownfield = !hasRijo && codeFiles.length > 3;
  const stackNotes: string[] = [];
  const baselineCommands: string[] = [];
  const pkgRaw = readTextIfExists(path.join(ctx.projectRoot, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
      const deps = Object.keys(pkg.dependencies ?? {});
      if (deps.length) stackNotes.push(`Existing dependencies: ${deps.slice(0, 20).join(', ')}`);
      for (const s of ['build', 'lint', 'test', 'typecheck']) {
        if (pkg.scripts?.[s]) baselineCommands.push(`npm run ${s}`);
      }
      if (baselineCommands.length) stackNotes.push(`Detected commands: ${baselineCommands.join(', ')}`);
    } catch {
      stackNotes.push('package.json exists but is unparseable');
    }
  }
  if (isBrownfield) {
    stackNotes.unshift(
      `BROWNFIELD: ${codeFiles.length} code files exist. Preserve the existing stack, patterns and contracts; structural changes need cost/risk/migration justification.`,
    );
  }
  return { isBrownfield, stackNotes, baselineCommands };
}

/**
 * Compute the final contents of the global canonical artifacts touched by a
 * milestone creation (pure: nothing is written here). PROJECT/RULES only when
 * missing; STACK is regenerated; DECISIONS is append-only.
 */
function buildGlobalArtifacts(
  ctx: { paths: import('../core/paths.js').RijoPaths; now: () => Date },
  extraction: PlanExtraction,
  brown: BrownfieldInfo,
  decisions: string[],
): Array<{ path: string; content: string }> {
  const { paths, now } = ctx;
  const ts = now().toISOString();
  const out: Array<{ path: string; content: string }> = [];
  if (!exists(paths.project)) {
    out.push({
      path: paths.project,
      content: serializeFrontmatter(
        { name: extraction.project_name, updated_at: ts },
        [`# ${extraction.project_name}`, '', extraction.project_summary, ''].join('\n'),
      ),
    });
  }
  if (!exists(paths.rules)) {
    out.push({
      path: paths.rules,
      content: serializeFrontmatter(
        { updated_at: ts },
        [
          '# Rules',
          '',
          ...(extraction.rules.length ? extraction.rules.map((r) => `- ${r}`) : []),
          '- Artifacts over conversation: no important progress lives only in chat.',
          '- No completion without objective evidence.',
          '- Conservative hypothesis + DECISIONS.md entry instead of unnecessary questions.',
          '',
        ].join('\n'),
      ),
    });
  }
  out.push({
    path: paths.stack,
    content: serializeFrontmatter(
      { updated_at: ts, validated_at: ts },
      [
        '# Stack',
        '',
        extraction.stack_summary || 'To be determined by phase 01 research.',
        '',
        ...(brown.stackNotes.length ? ['## Detected environment', ...brown.stackNotes.map((n) => `- ${n}`)] : []),
        ...(brown.baselineCommands.length ? ['', '## Verified commands', ...brown.baselineCommands.map((c) => `- \`${c}\``)] : []),
        '',
      ].join('\n'),
    ),
  });
  const decisionsHeader = exists(paths.decisions) ? readText(paths.decisions) : '# Decisions (append-only)\n';
  const newEntries = decisions.map((d) => `- ${ts} — ${d}`).join('\n');
  if (decisions.length) {
    out.push({ path: paths.decisions, content: `${decisionsHeader.trimEnd()}\n${newEntries}\n` });
  } else if (!exists(paths.decisions)) {
    out.push({ path: paths.decisions, content: decisionsHeader });
  }
  return out;
}

function summarizePreviousMilestones(ctx: { paths: import('../core/paths.js').RijoPaths }): string {
  const manifest = readManifest(ctx.paths);
  if (!manifest) return '';
  const lines: string[] = ['PREVIOUS MILESTONES (context, do not re-plan):'];
  for (const m of manifest.milestones) {
    lines.push(`- ${m.id} (${m.slug}): ${m.status}`);
  }
  const decisions = readTextIfExists(ctx.paths.decisions);
  if (decisions) lines.push('', 'GLOBAL DECISIONS:', decisions.slice(0, 2000));
  return lines.join('\n');
}

function slugName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'phase'
  );
}
