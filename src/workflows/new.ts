import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import {
  ensureDir,
  exists,
  inventory,
  readText,
  readTextIfExists,
  sha256,
  writeFileAtomic,
} from '../core/fsx.js';
import { computePlanHash } from '../durable/engine.js';
import { ensureDurableGitignore } from '../durable/ignore.js';
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
import { ManifestSchema, RequirementSchema, RoadmapPhaseSchema, looseBool } from '../core/schemas/index.js';
import { ResearchStore } from '../research/cache.js';
import { renderBrief } from '../agents/prompts.js';
import { AgentTaskSchema, type AgentTaskDraft } from '../agents/protocol.js';
import { generateAdapters } from '../adapters/index.js';
import {
  createContext,
  withLock,
  blocked,
  blockedReadOnly,
  completed,
  failed,
  dispatch,
  dispatchBatch,
  commitDecisionProposals,
  discardDecisionProposals,
  durableCheckpoint,
  isWorkflowCancellation,
  type WorkflowDeps,
  type WorkflowOutcome,
  type ValidatedAgentEnvelope,
} from './shared.js';
import { buildContextPacket, gapsAffectingScope } from '../codebase/context.js';
import { readMapState } from '../codebase/state.js';

export interface NewOptions {
  planFile: string;
  next?: boolean;
  /** @deprecated Run `rijo ui` after setup. */
  ui?: string;
  /** @deprecated `new` is setup-only. Run `rijo start` separately. */
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
      non_functional: looseBool(false),
      // Out-of-vocabulary classifications (a model confusing this field with,
      // e.g., "functional") fall back to NEW — the only correct value on a
      // greenfield first milestone anyway; a real CHANGE/REMOVE is still honored.
      classification: z.enum(['NEW', 'CHANGE', 'REMOVE', 'CARRYOVER', 'UNCHANGED_DEPENDENCY']).catch('NEW'),
    }),
  ),
  phases: z.array(
    z.object({
      name: z.string(),
      requirement_indexes: z.array(z.number().int()),
      depends_on_indexes: z.array(z.number().int()).default([]),
      ui_surface: looseBool(false),
    }),
  ),
  research_topics: z
    .array(z.object({ key: z.string(), topic: z.string(), volatile: looseBool(true) }))
    .default([]),
});
export type PlanExtraction = z.infer<typeof PlanExtractionSchema>;

export function validatePlanExtractionFidelity(plan: string, extraction: PlanExtraction): string[] {
  const errors: string[] = [];
  const numberWords: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const normalizedPlan = plan.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const countMatch = normalizedPlan.match(/\bexactly\s+(\d+|[a-z]+)\s+(?:sequential\s+)?phases\b/);
  if (countMatch) {
    const token = countMatch[1]!;
    const expected = /^\d+$/.test(token) ? Number(token) : numberWords[token];
    if (expected !== undefined && extraction.phases.length !== expected) {
      errors.push(`phases: plan explicitly requires ${expected}, but extraction returned ${extraction.phases.length}`);
    }
  }
  const dependencyPattern = /\bphase\s+0?(\d+)\s+depends\s+on\s+phase\s+0?(\d+)\b/g;
  for (const match of normalizedPlan.matchAll(dependencyPattern)) {
    const phaseIndex = Number(match[1]) - 1;
    const dependencyIndex = Number(match[2]) - 1;
    const phase = extraction.phases[phaseIndex];
    if (phase && !phase.depends_on_indexes.includes(dependencyIndex)) {
      errors.push(`phases.${phaseIndex}.depends_on_indexes: plan explicitly requires dependency on phase ${dependencyIndex + 1}`);
    }
  }
  return errors;
}

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
  // Hash the exact bytes whose content is planned below. The durable ledger
  // uses this identity to distinguish resume from a genuinely new contract.
  const planContent = readText(planPath);
  const planHash = computePlanHash(planContent);
  const hasRijo = exists(paths.manifest);
  const existingManifest = hasRijo ? readManifest(paths) : null;
  const isSetupManifest =
    existingManifest !== null &&
    existingManifest.active_milestone === null &&
    existingManifest.milestones.length === 0;
  if (!hasRijo && opts.next) {
    return failed(ctx, '--next requires an existing RIJO project; run rijo new without --next first.');
  }

  return withLock(ctx, async () => {
    if (opts.next && ctx.durableRun?.disposition === 'resumed') {
      return blockedReadOnly(
        ctx,
        'The active durable run must reach a terminal checkpoint before a new milestone can start.',
        ['Resume the active run before retrying this --next contract.'],
      );
    }
    if (ctx.durableRun?.disposition === 'plan_mismatch') {
      return blockedReadOnly(
        ctx,
        opts.next
          ? 'The active durable run must reach a terminal checkpoint before a new milestone can start.'
          : 'The plan differs from the active durable run; ambiguous reuse is refused.',
        opts.next
          ? ['Resume the active run with its original plan before retrying this --next contract.']
          : [`To start the next milestone run: rijo new @${path.basename(planPath)} --next`],
      );
    }
    if (hasRijo && !opts.next && !isSetupManifest) {
      return blockedReadOnly(
        ctx,
        'A RIJO project already exists here. Re-initialization is refused (non-destructive).',
        [`To start the next milestone run: rijo new @${path.basename(planPath)} --next`],
      );
    }
    bus.emit('new.scope_parse', {
      status: 'running',
      stage: 'SCOPE_PARSE',
      message: '[RIJO] SCOPE_PARSE',
    });

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
          'Resume it with `$rijo resume` or resolve the checkpoint before starting the next milestone.',
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
            'Resume it with `$rijo resume` or resolve the checkpoint before starting the next milestone.',
          ]);
        }
      }
      const userDirty = gitStatus.dirtyFiles.filter((file) => file !== '.rijo/events.jsonl');
      if (gitStatus.isRepo && userDirty.length > 0) {
        return blocked(ctx, 'Unknown local changes present; they will never be discarded or stashed automatically.', [
          `Dirty files: ${userDirty.slice(0, 20).join(', ')}`,
          'Commit or intentionally revert them, then re-run.',
        ]);
      }
    }

    // ---- brownfield detection
    const brown = detectBrownfield(ctx);
    const hasCodebaseMap = exists(paths.codebaseMapState);
    if (brown.isBrownfield) {
      bus.emit('new.brownfield', { message: 'Brownfield project detected.' }, { notes: brown.stackNotes });
      if (!hasCodebaseMap && !opts.next) {
        return blockedReadOnly(
          ctx,
          'Run `$rijo map-codebase`, then run `$rijo new @PLAN.md` again.',
        );
      }
    }

    // ---- read the plan and extract structure via planner agent
    bus.emit('new.analyze', { stage: 'ANALYZE', message: 'Extract scope and requirements from the plan.' });
    let codebaseContext = '';
    if (brown.isBrownfield && hasCodebaseMap) {
      const mapState = readMapState(paths);
      if (!mapState || mapState.status === 'BLOCKED') {
        return blocked(ctx, 'Brownfield codebase map is blocked for planning.', [
          `Map status: ${mapState?.status ?? 'missing'}.`,
          `Relevant stale paths: ${mapState?.changed_paths_since_map.join(', ') || 'unknown'}.`,
          ...(mapState?.gaps ?? []),
        ]);
      }
      const packet = buildContextPacket(
        projectRoot,
        planContent,
        Math.min(config.context_budget_bytes, Math.max(4096, Math.floor(config.context_budget_bytes * 0.6))),
      );
      const affectingGaps = gapsAffectingScope(mapState.gaps, planContent);
      if (mapState.status === 'PARTIAL' && affectingGaps.length > 0) {
        return blocked(ctx, 'Brownfield codebase map has gaps in the requested planning scope.', affectingGaps);
      }
      codebaseContext = packet.text;
      bus.emit(
        'new.map_context',
        { message: `Focused map context: ${packet.selected_modules.length} modules, ${packet.bytes} bytes.` },
        { modules: packet.selected_modules, bytes: packet.bytes, freshness: packet.freshness },
      );
    }
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
      notes:
        [previousContext, brown.stackNotes.join('\n'), codebaseContext].filter(Boolean).join('\n\n') +
        `\n\nPLAN CONTENT:\n${planContent}`,
    };
    // Extraction is a payload-returning dispatch: a model occasionally answers
    // ok:true but leaves the structured data in prose (payload null) or emits a
    // slightly off-shape payload. Neither is a fatal planner failure — re-dispatch
    // with a sharpened reminder, bounded by plan_revisions, before giving up.
    let extraction: PlanExtraction | null = null;
    let extractionEnvelope: import('./shared.js').ValidatedAgentEnvelope | null = null;
    let lastExtractSummary = '';
    let lastExtractErrors: string[] = [];
    const extractAttempts = ctx.config.limits.plan_revisions + 1;
    for (let attempt = 0; attempt < extractAttempts; attempt++) {
      const task: AgentTaskDraft =
        attempt === 0
          ? extractTask
          : {
              ...extractTask,
              id: `new-extract-r${attempt}`,
              notes:
                `${extractTask.notes}\n\nIMPORTANT: put the extraction JSON in the AgentResult "payload" field (not prose), ` +
                'matching the PlanExtraction schema exactly: classification is one of NEW|CHANGE|REMOVE|CARRYOVER|UNCHANGED_DEPENDENCY and every boolean is a real JSON boolean.\n' +
                `CORRECT THESE EXACT ERRORS FROM THE PREVIOUS RESULT:\n${lastExtractErrors.map((error) => `- ${error}`).join('\n')}`,
            };
      const extractResult = await dispatch(ctx, task, { stage: 'PLAN' });
      lastExtractSummary = extractResult.summary;
      lastExtractErrors = [];
      if (extractResult.ok && extractResult.payload) {
        const parsed = PlanExtractionSchema.safeParse(extractResult.payload);
        if (parsed.success) {
          const fidelityErrors = validatePlanExtractionFidelity(planContent, parsed.data);
          if (fidelityErrors.length === 0) {
            extraction = parsed.data;
            extractionEnvelope = extractResult;
            break;
          }
          lastExtractErrors = fidelityErrors;
        } else {
          lastExtractErrors = parsed.error.issues.map(
            (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<payload>'}: ${issue.message}`,
          );
        }
      } else if (!extractResult.ok) {
        lastExtractErrors = [`AgentResult rejected: ${extractResult.summary}`];
      } else {
        lastExtractErrors = ['payload: required PlanExtraction object was null or absent'];
      }
      discardDecisionProposals(ctx, extractResult);
      // Native mode is a two-step exchange. The host must answer the exported
      // request before RIJO can validate or revise the payload. Do not create
      // artificial correction tasks for a result that does not exist yet.
      if (extractResult.summary.includes('native result bundle has no result for task')) break;
      // The workflow is being torn down (deadline/host disconnect): stop retrying
      // so the unwind is not blocked by a fresh dispatch to a dead host.
      if (isWorkflowCancellation(extractResult)) break;
    }
    if (!extraction) {
      // A planner that cannot produce a valid extraction payload is a planner
      // FAILURE, not a workflow block: use failed() so a --next transition stays
      // fully non-destructive (blocked() would persist STATE.md/manifest when a
      // previous phase exists, corrupting the "untouched on failure" guarantee).
      return failed(ctx, 'Plan extraction failed.', [
        lastExtractSummary,
        ...lastExtractErrors,
        `Brief was:\n${renderBrief(AgentTaskSchema.parse(extractTask)).slice(0, 400)}…`,
      ]);
    }

    // ---- STAGING: build the new milestone entirely in memory and validate it
    // BEFORE any durable mutation. The prospective ID is deterministic; sealing
    // and createMilestone happen only after validation passes.
    if (!hasRijo) {
      ensureDir(paths.root);
      ensureDir(paths.runtimeDir);
      ensureDir(paths.fixesDir);
      ensureDir(paths.importsDir);
      ensureDir(paths.phasesDir);
      ensureDir(paths.uiDir);
      ensureDir(paths.qaDir);
      ensureDir(paths.archiveDir);
      ensureDir(paths.researchDir);
      // volatile internals never enter version control
      writeFileAtomic(path.join(paths.root, '.gitignore'), ['runtime/', 'archive/', ''].join('\n'));
      ensureDurableGitignore(projectRoot);
      if (!exists(paths.config)) saveConfig(paths, defaultConfig());
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

    // ---- research (three bounded read-only lanes)
    bus.emit('new.project_research', {
      status: 'running',
      stage: 'PROJECT_RESEARCH',
      message: `[RIJO ${milestone.id}] PROJECT_RESEARCH`,
    });
    bus.emit('new.research', { stage: 'RESEARCH', message: 'Run focused technical research.' });
    const store = new ResearchStore(paths, now);
    const requestedTopics = extraction.research_topics.map((topic) => topic.topic).join('; ');
    const topics = [
      {
        key: 'project-stack-v1',
        topic: 'Stable stack versions and official implementation practices',
        volatile: true,
        focus:
          'Select stable stack versions. Use official release, support, and implementation guidance.',
      },
      {
        key: 'project-architecture-v1',
        topic: 'Architecture boundaries, integrations, and system limits',
        volatile: true,
        focus:
          'Define simple architecture boundaries. Validate integrations, compatibility, and operational limits.',
      },
      {
        key: 'project-risks-v1',
        topic: 'Gaps, pitfalls, data integrity, and security surfaces',
        volatile: true,
        focus:
          'Find scope gaps, common failure modes, data risks, and security controls for affected features.',
      },
    ];
    const toResearch = topics.filter((t) => !store.lookup(t.key));
    const cached = topics.filter((t) => store.lookup(t.key));
    let researchSummaries: string[] = cached.map((t) => `- ${t.topic}: ${store.lookup(t.key)!.summary}`);
    if (toResearch.length > 0) {
      const tasks: AgentTaskDraft[] = toResearch.map((t, i) => ({
        id: `new-research-${i + 1}`,
        role: 'researcher',
        objective: [
          `Research lane: ${t.topic}.`,
          t.focus,
          'Prefer official docs, release pages, support policies, registries, and primary advisories.',
          'Do not assume that the newest version is the best version.',
          'Separate facts, inferences, and recommendations.',
        ].join(' '),
        canonical_files: [],
        code_files: [],
        write_scope: [],
        acceptance_criteria: ['Every volatile claim has source title, url, check date and version'],
        verification_commands: [],
        return_format:
          'JSON payload: {summary: string, sources: [{claim: string, source: string, url: string, checked_at: ISO-8601 string, version: string, confidence: high|medium|low, tier: official|advisory|secondary}]}. Use the exact confidence and tier strings. Use tier=official for official docs or registries. Use tier=advisory for primary security advisories.',
        notes: `Plan-specific volatile topics: ${requestedTopics || 'none declared'}.`,
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
          discardDecisionProposals(ctx, r);
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
                  confidence: z.preprocess(
                    (value) => {
                      if (typeof value !== 'number' || !Number.isFinite(value)) return value;
                      if (value >= 0.8) return 'high';
                      if (value >= 0.5) return 'medium';
                      return 'low';
                    },
                    z.enum(['high', 'medium', 'low']).default('medium'),
                  ),
                  tier: z.enum(['official', 'advisory', 'secondary']).default('secondary'),
                }),
              )
              .default([]),
          })
          .safeParse(r.payload);
        if (!payload.success) {
          discardDecisionProposals(ctx, r);
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
        commitDecisionProposals(ctx, r);
        researchSummaries.push(`- ${topic.topic}: ${payload.data.summary}`);
      }
      // long-project hygiene: keep sources.json bounded, archive the oldest
      const compacted = store.compactSources(config.research.max_sources);
      if (compacted.archived > 0) {
        bus.emit('research.compacted', { message: `Archived ${compacted.archived} sources in ${path.basename(compacted.archiveFile!)}.` });
      }
    }

    // ---- independent outcome-oriented roadmapper
    bus.emit('new.decision_validation', {
      stage: 'DECISION_VALIDATION',
      message: 'Validate researched decisions before system design.',
    });
    bus.emit('new.system_design', {
      stage: 'SYSTEM_DESIGN',
      message: 'Define the system boundaries and roadmap outcomes.',
    });
    const RoadmapPayloadSchema = z.object({
      phases: PlanExtractionSchema.shape.phases.min(1).max(6),
      rationale: z.string().min(1),
    });
    const roadmapTask: AgentTaskDraft = {
      id: 'new-roadmap',
      role: 'planner',
      objective: [
        'Create an outcome-oriented roadmap from the approved scope and the research synthesis.',
        'Use three to six natural phases for a typical project.',
        'Use fewer phases when the scope is genuinely smaller.',
        'Do not add phases only to reach a number.',
        'Do not create separate security, test, cleanup, audit, or refactor phases.',
        'Put security, data integrity, error handling, and verification in the phase that creates each surface.',
        'Map every requirement index exactly once.',
      ].join(' '),
      canonical_files: [planPath],
      code_files: [],
      write_scope: [],
      acceptance_criteria: [
        'Each phase ends in observable product behavior.',
        'Dependencies are explicit.',
        'Every requirement is assigned once.',
      ],
      verification_commands: [],
      return_format:
        'JSON payload: {phases:[{name:string,requirement_indexes:number[],depends_on_indexes:number[],ui_surface:boolean}], rationale:string}.',
      notes: [
        `PROJECT: ${extraction.project_name}`,
        `SUMMARY: ${extraction.project_summary}`,
        `REQUIREMENTS:\n${extraction.requirements.map((requirement, index) => `${index}: ${requirement.description} — ${requirement.acceptance}`).join('\n')}`,
        `RESEARCH:\n${researchSummaries.join('\n')}`,
        `RULES:\n${extraction.rules.join('\n')}`,
      ].join('\n\n'),
    };
    let roadmapResult: ValidatedAgentEnvelope | null = null;
    let roadmapPayload: z.SafeParseReturnType<unknown, z.infer<typeof RoadmapPayloadSchema>> | null = null;
    let roadmapErrors: string[] = [];
    for (let attempt = 0; attempt <= config.limits.plan_revisions; attempt++) {
      const correctionNotes =
        attempt === 0
          ? roadmapTask.notes
          : [
              roadmapTask.notes,
              'CORRECT THESE EXACT ERRORS:',
              ...roadmapErrors.map((error) => `- ${error}`),
            ].join('\n\n');
      roadmapResult = await dispatch(
        ctx,
        {
          ...roadmapTask,
          id: attempt === 0 ? roadmapTask.id : `${roadmapTask.id}-r${attempt}`,
          notes: correctionNotes,
        },
        { stage: 'PLAN' },
      );
      roadmapPayload = RoadmapPayloadSchema.safeParse(roadmapResult.payload);
      if (roadmapResult.ok && roadmapPayload.success) break;
      discardDecisionProposals(ctx, roadmapResult);
      roadmapErrors = roadmapPayload.success
        ? [roadmapResult.summary]
        : roadmapPayload.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    }
    if (!roadmapResult || !roadmapPayload?.success || !roadmapResult.ok) {
      return failed(ctx, 'Independent roadmap generation failed.', [
        roadmapResult?.summary ?? 'The roadmapper returned no result.',
        ...roadmapErrors,
      ]);
    }
    const roadmapFidelity = validatePlanExtractionFidelity(planContent, {
      ...extraction,
      phases: roadmapPayload.data.phases,
    });
    if (roadmapFidelity.length > 0) {
      discardDecisionProposals(ctx, roadmapResult);
      return failed(ctx, 'Independent roadmap validation failed.', roadmapFidelity);
    }
    extraction.phases = roadmapPayload.data.phases;
    phases.splice(
      0,
      phases.length,
      ...extraction.phases.map((phase, index) =>
        RoadmapPhaseSchema.parse({
          id: String(index + 1).padStart(2, '0'),
          slug: slugName(phase.name),
          name: phase.name,
          depends_on: phase.depends_on_indexes.map((dependency) =>
            String(dependency + 1).padStart(2, '0'),
          ),
          requirements: [],
          status: 'PENDING',
          ui_surface: phase.ui_surface,
        }),
      ),
    );
    for (const requirement of requirements) requirement.phase = null;
    extraction.phases.forEach((phase, phaseIndex) => {
      for (const requirementIndex of phase.requirement_indexes) {
        const requirement = requirements[requirementIndex];
        if (requirement && !requirement.phase) {
          requirement.phase = phases[phaseIndex]!.id;
          phases[phaseIndex]!.requirements.push(requirement.id);
        }
      }
    });
    for (const requirement of requirements) {
      if (!requirement.phase && phases.length > 0) {
        requirement.phase = phases[0]!.id;
        phases[0]!.requirements.push(requirement.id);
        decisions.push(`Assigned ${requirement.id} to phase 01 because it was not indexed by the approved roadmap payload.`);
      }
    }
    const roadmapIssues = validateTraceability({ requirements, phases });
    if (roadmapIssues.some((issue) => issue.severity === 'error')) {
      discardDecisionProposals(ctx, roadmapResult);
      return failed(
        ctx,
        'Independent roadmap traceability validation failed.',
        roadmapIssues.map((issue) => `${issue.code}: ${issue.message} — ${issue.fix}`),
      );
    }
    commitDecisionProposals(ctx, roadmapResult);
    decisions.push(`Roadmap: ${roadmapPayload.data.rationale}`);

    // ---- build EVERY canonical artifact of the transition in memory
    bus.emit('new.persist', {
      stage: 'CONTEXT_COMMIT',
      message: `[RIJO ${milestone.id}] CONTEXT_COMMIT`,
    });
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
          ? `$rijo ui @${opts.ui.replace(/^@/, '')}`
          : '$rijo start',
        updated_at: now().toISOString(),
      },
      `Milestone ${milestone.id} created from ${path.basename(planPath)}. ${requirements.length} requirements across ${phases.length} phases.`,
    );
    const globals = buildGlobalArtifacts(
      ctx,
      extraction,
      brown,
      decisions,
      researchSummaries,
      requirementsContent,
      roadmapContent,
    );

    const relRoot = (p: string) => path.relative(projectRoot, p).split(path.sep).join('/');
    const relRijo = (p: string) => path.relative(paths.root, p).split(path.sep).join('/');

    if (opts.next && activePrev) {
      // ---- CRASH-SAFE TRANSACTION: seal the previous milestone and activate
      // the next one through a single atomic commit point. Nothing outside
      // .rijo/runtime changes before commitPoint(); after it, apply is
      // deterministic and idempotent (startup reconciliation rolls forward).
      const allDone = carryoverItems.length === 0;
      const alreadySealed = exists(activePrev.paths.closeout);
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
      if (!alreadySealed) {
        try {
          validateSeal(activePrev, sealInput, prevReqDoc);
        } catch (err) {
          return failed(ctx, `Milestone ${activePrev.id} cannot be sealed.`, [(err as Error).message]);
        }
      }
      const sealedReqDoc =
        prevReqDoc && !alreadySealed
          ? applySealDispositions(prevReqDoc, carryoverItems)
          : prevReqDoc;
      const closeoutContent = alreadySealed
        ? readText(activePrev.paths.closeout)
        : renderCloseout(activePrev, sealInput, sealedReqDoc, now);

      const manifest = readManifest(paths)!;
      const prevEntry = manifest.milestones.find((m) => m.id === activePrev.id);
      if (prevEntry && !alreadySealed) prevEntry.status = sealInput.status;
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
      if (sealedReqDoc && !alreadySealed) {
        overlay.set(relRijo(activePrev.paths.requirements), renderRequirements(sealedReqDoc));
      }
      for (const g of globals) overlay.set(relRijo(g.path), g.content);
      manifest.hashes = computeHashes(paths, overlay);
      const manifestContent = JSON.stringify(ManifestSchema.parse(manifest), null, 2) + '\n';

      const tx = MilestoneTransaction.begin(paths, { kind: 'milestone-next', prev: activePrev.id, next: newId }, deps.txnHooks ?? {}, now);
      tx.stageDir(relRoot(mp.phasesDir));
      tx.stageDir(relRoot(path.join(mp.qaDir, 'journeys')));
      tx.stageDir(relRoot(path.join(mp.qaDir, 'screenshots')));
      tx.stageDir(relRoot(path.join(mp.qaDir, 'traces')));
      if (!alreadySealed) {
        tx.stage(relRoot(activePrev.paths.closeout), closeoutContent);
        if (sealedReqDoc) {
          tx.stage(relRoot(activePrev.paths.requirements), renderRequirements(sealedReqDoc));
        }
      }
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

      if (!alreadySealed && config.git.tag_milestones && gitStatus.isRepo) {
        ctx.git.tag(projectRoot, `rijo/${activePrev.id}`, `RIJO milestone ${activePrev.id} sealed`);
      }
      if (!alreadySealed) {
        bus.emit(
          'milestone.sealed',
          { message: `Milestone ${activePrev.id} sealed (${allDone ? 'COMPLETE' : 'PARTIAL'}).` },
          { milestone: activePrev.id },
        );
      }
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
    bus.emit('new.adapters', {
      message: `Generated adapters: ${adapterReport.generated.join(', ') || 'none'}.`,
    });

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
    if (extractionEnvelope) commitDecisionProposals(ctx, extractionEnvelope);
    await durableCheckpoint(ctx, `milestone:${milestone.id}:created`, {
      commit: ctx.git.headCommit(projectRoot),
    });

    bus.emit(
      'new.done',
      {
        status: 'completed',
        stage: 'ROADMAP_READY',
        milestone: { id: milestone.id, name: extraction.project_name },
        message: `[RIJO ${milestone.id}] ROADMAP_READY`,
      },
      { requirements: requirements.length, phases: phases.length },
    );

    return completed(ctx, `Milestone ${milestone.id} created (${requirements.length} requirements, ${phases.length} phases).`);
  }, {
    run: { plan: planContent, planHash, next: Boolean(opts.next), host: ctx.hostProvider },
    terminal: false,
  });
}

function detectBrownfield(ctx: { projectRoot: string }): BrownfieldInfo {
  const inv = inventory(ctx.projectRoot, { skipDirs: ['node_modules', '.git', 'dist', '.rijo', '.next', 'coverage'] });
  const codeFiles = inv.filter((f) => /\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs)$/.test(f.relPath));
  // An initialized but unborn repository is still a greenfield workspace:
  // untracked source there is protected as pre-existing user work by run's
  // conflict gate, not treated as a committed brownfield architecture.
  const unbornRepository =
    exists(path.join(ctx.projectRoot, '.git')) &&
    spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ctx.projectRoot, stdio: 'ignore' }).status !== 0;
  const isBrownfield = codeFiles.length > 0 && !unbornRepository;
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
  researchSummaries: string[],
  requirementsContent: string,
  roadmapContent: string,
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
      { updated_at: ts },
      [
        '# Stack',
        '',
        extraction.stack_summary || 'To be determined by phase 01 research.',
        '',
        '## Project research',
        ...(researchSummaries.length ? researchSummaries : ['- No project research was required.']),
        '',
        ...(brown.stackNotes.length ? ['## Detected environment', ...brown.stackNotes.map((n) => `- ${n}`)] : []),
        ...(brown.baselineCommands.length
          ? ['', '## Detected commands (execution evidence is in .rijo/codebase/BASELINE.md)', ...brown.baselineCommands.map((c) => `- \`${c}\``)]
          : []),
        '',
      ].join('\n'),
    ),
  });
  out.push({ path: paths.requirements, content: requirementsContent });
  out.push({ path: paths.roadmap, content: roadmapContent });
  out.push({
    path: paths.architecture,
    content: serializeFrontmatter(
      { updated_at: ts },
      [
        '# Architecture',
        '',
        extraction.stack_summary || 'The active phase research will define the implementation boundaries.',
        '',
        brown.isBrownfield
          ? 'Use the evidence-backed codebase map in `.rijo/codebase/`.'
          : 'Use the roadmap phases as reversible vertical slices.',
        '',
        '## Researched constraints',
        ...(researchSummaries.length ? researchSummaries : ['- No additional constraints were found.']),
        '',
      ].join('\n'),
    ),
  });
  out.push({
    path: paths.integrations,
    content: serializeFrontmatter(
      { updated_at: ts },
      [
        '# Integrations',
        '',
        'Record external systems, credentials, permissions, and failure behavior here.',
        '',
        'No external integration is approved by inference.',
        '',
        '## Researched integration constraints',
        ...(researchSummaries.length ? researchSummaries : ['- No external integration was selected.']),
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
