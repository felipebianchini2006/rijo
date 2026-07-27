import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, exists, writeFileAtomic, readTextIfExists } from './fsx.js';
import { serializeFrontmatter } from './frontmatter.js';
import { RijoPaths, milestonePaths, type MilestonePaths } from './paths.js';
import { readManifest, touchManifest } from './manifest.js';
import type { Manifest, MilestoneStatus, Requirement } from './schemas/index.js';
import { readRequirements, writeRequirements } from './roadmap.js';

export interface MilestoneRef {
  id: string;
  slug: string;
  dir: string;
  paths: MilestonePaths;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'scope'
  );
}

export function nextMilestoneId(manifest: Manifest | null): string {
  const max = (manifest?.milestones ?? []).reduce((acc, m) => {
    const n = Number(m.id.slice(1));
    return Number.isFinite(n) && n > acc ? n : acc;
  }, 0);
  return `M${String(max + 1).padStart(3, '0')}`;
}

export function activeMilestone(paths: RijoPaths): MilestoneRef | null {
  const manifest = readManifest(paths);
  if (!manifest?.active_milestone) return null;
  const entry = manifest.milestones.find((m) => m.id === manifest.active_milestone);
  if (!entry) return null;
  const dir = paths.milestoneDir(entry.id, entry.slug);
  return { id: entry.id, slug: entry.slug, dir, paths: milestonePaths(dir) };
}

export function milestoneRef(paths: RijoPaths, id: string): MilestoneRef | null {
  const manifest = readManifest(paths);
  const entry = manifest?.milestones.find((m) => m.id === id);
  if (!entry) return null;
  const dir = paths.milestoneDir(entry.id, entry.slug);
  return { id: entry.id, slug: entry.slug, dir, paths: milestonePaths(dir) };
}

/** Create milestone directory skeleton. Registers it in the manifest as ACTIVE. */
export function createMilestone(
  paths: RijoPaths,
  name: string,
  now: () => Date = () => new Date(),
): MilestoneRef {
  const manifest = readManifest(paths);
  const id = nextMilestoneId(manifest);
  const slug = slugify(name);
  const dir = paths.milestoneDir(id, slug);
  if (exists(dir)) throw new Error(`Milestone directory already exists: ${dir}`);
  ensureDir(dir);
  const mp = milestonePaths(dir);
  ensureDir(mp.phasesDir);
  ensureDir(mp.qaDir);
  ensureDir(path.join(mp.qaDir, 'journeys'));
  ensureDir(path.join(mp.qaDir, 'screenshots'));
  ensureDir(path.join(mp.qaDir, 'traces'));
  touchManifest(
    paths,
    (m) => {
      m.milestones.push({ id, slug, status: 'ACTIVE' });
      m.active_milestone = id;
    },
    now,
  );
  updateMilestonesIndex(paths, now);
  return { id, slug, dir, paths: mp };
}

export interface CarryoverItem {
  requirement: Requirement;
  disposition: 'carried' | 'debt' | 'cancelled' | 'blocked';
}

export interface CloseoutInput {
  status: Exclude<MilestoneStatus, 'ACTIVE'>;
  baselineCommit: string | null;
  baselineBranch: string | null;
  deliveredVersion: string | null;
  carryover: CarryoverItem[];
  evidence: string[];
  residualRisks: string[];
  productionState: string;
}

/**
 * Validate that a milestone CAN be sealed with the given closeout input.
 * Throws with a precise diagnostic; mutates nothing.
 */
export function validateSeal(
  ref: MilestoneRef,
  input: CloseoutInput,
  reqDoc: { requirements: Requirement[] } | null,
  options: { allowExistingCloseout?: boolean } = {},
): void {
  if (exists(ref.paths.closeout) && !options.allowExistingCloseout) {
    throw new Error(`Milestone ${ref.id} already has a CLOSEOUT.md; historic milestones are immutable`);
  }
  const undone = reqDoc?.requirements.filter((r) => r.status !== 'DONE') ?? [];
  if (input.status === 'COMPLETE' && undone.length > 0) {
    throw new Error(
      `Milestone ${ref.id} cannot close as COMPLETE: unverified requirements remain (${undone
        .map((r) => r.id)
        .join(', ')}). Close as PARTIAL or finish the work.`,
    );
  }
  const classified = new Set(input.carryover.map((c) => c.requirement.id));
  const unclassified = undone.filter((r) => !classified.has(r.id));
  if (unclassified.length > 0) {
    throw new Error(
      `Unfinished requirements must be classified (carried/debt/cancelled/blocked): ${unclassified
        .map((r) => r.id)
        .join(', ')}`,
    );
  }
}

/** Apply carryover dispositions to the sealed milestone's requirement doc (pure). */
export function applySealDispositions<T extends { requirements: Requirement[] }>(reqDoc: T, carryover: CarryoverItem[]): T {
  for (const item of carryover) {
    const req = reqDoc.requirements.find((r) => r.id === item.requirement.id);
    if (!req) continue;
    req.status =
      item.disposition === 'carried'
        ? 'CARRIED'
        : item.disposition === 'debt'
          ? 'DEBT'
          : item.disposition === 'cancelled'
            ? 'CANCELLED'
            : 'BLOCKED';
  }
  return reqDoc;
}

/** Render the CLOSEOUT.md content (pure). */
export function renderCloseout(
  ref: MilestoneRef,
  input: CloseoutInput,
  reqDoc: { requirements: Requirement[] } | null,
  now: () => Date = () => new Date(),
): string {
  const done = reqDoc?.requirements.filter((r) => r.status === 'DONE') ?? [];
  const fm = {
    milestone: ref.id,
    status: input.status,
    baseline_commit: input.baselineCommit,
    baseline_branch: input.baselineBranch,
    delivered_version: input.deliveredVersion,
    closed_at: now().toISOString(),
    requirements_done: done.map((r) => r.id),
    carryover: input.carryover.map((c) => ({ id: c.requirement.id, disposition: c.disposition })),
  };
  const body = [
    `# Closeout — ${ref.id}`,
    '',
    `Status: **${input.status}**`,
    input.baselineCommit ? `Baseline: \`${input.baselineCommit}\` (${input.baselineBranch ?? 'n/a'})` : 'Baseline: no VCS',
    `Production state: ${input.productionState}`,
    '',
    '## Delivered requirements',
    ...(done.length ? done.map((r) => `- ${r.id}: ${r.description}`) : ['- none']),
    '',
    '## Evidence',
    ...(input.evidence.length ? input.evidence.map((e) => `- ${e}`) : ['- none recorded']),
    '',
    '## Carryover / debt / cancelled / blocked',
    ...(input.carryover.length
      ? input.carryover.map((c) => `- ${c.requirement.id} → ${c.disposition}`)
      : ['- none']),
    '',
    '## Residual risks',
    ...(input.residualRisks.length ? input.residualRisks.map((r) => `- ${r}`) : ['- none identified']),
    '',
  ].join('\n');
  return serializeFrontmatter(fm, body);
}

/**
 * Seal a milestone: classify incomplete requirements, write CLOSEOUT.md,
 * update requirement statuses. Historic artifacts are never rewritten —
 * only statuses and the closeout are added. The active_milestone pointer is
 * NOT changed here; the caller swaps it in the same transaction that creates
 * the next milestone. (Direct-write variant; `rijo new --next` stages these
 * same contents through the crash-safe MilestoneTransaction instead.)
 */
export function sealMilestone(
  paths: RijoPaths,
  ref: MilestoneRef,
  input: CloseoutInput,
  now: () => Date = () => new Date(),
): void {
  const reqDoc = exists(ref.paths.requirements) ? readRequirements(ref.paths.requirements) : null;
  validateSeal(ref, input, reqDoc);
  const doneDoc = reqDoc ? applySealDispositions(reqDoc, input.carryover) : null;
  const closeout = renderCloseout(ref, input, doneDoc, now);
  if (doneDoc) writeRequirements(ref.paths.requirements, doneDoc);
  writeFileAtomic(ref.paths.closeout, closeout);

  touchManifest(
    paths,
    (m) => {
      const entry = m.milestones.find((x) => x.id === ref.id);
      if (entry) entry.status = input.status;
    },
    now,
  );
  updateMilestonesIndex(paths, now);
}

/**
 * Register a closeout that the native host wrote before it called the helper.
 * Preserve the host report. Update only the portable milestone indexes.
 */
export function registerExistingCloseout(
  paths: RijoPaths,
  ref: MilestoneRef,
  input: CloseoutInput,
  now: () => Date = () => new Date(),
): void {
  if (!exists(ref.paths.closeout)) {
    throw new Error(`Milestone ${ref.id} has no CLOSEOUT.md to register`);
  }
  const reqDoc = exists(ref.paths.requirements) ? readRequirements(ref.paths.requirements) : null;
  validateSeal(ref, input, reqDoc, { allowExistingCloseout: true });
  const doneDoc = reqDoc ? applySealDispositions(reqDoc, input.carryover) : null;
  if (doneDoc) writeRequirements(ref.paths.requirements, doneDoc);
  touchManifest(
    paths,
    (manifest) => {
      const entry = manifest.milestones.find((candidate) => candidate.id === ref.id);
      if (entry) entry.status = input.status;
    },
    now,
  );
  updateMilestonesIndex(paths, now);
}

/** Carry a requirement into a new milestone with a fresh namespaced ID. */
export function carryRequirement(req: Requirement, newMilestoneId: string, seq: number): Requirement {
  return {
    ...req,
    id: `${newMilestoneId}-REQ-${String(seq).padStart(3, '0')}`,
    status: 'PENDING',
    classification: 'CARRYOVER',
    carried_from: req.id,
    phase: null,
    tests: [],
    evidence: null,
    no_test_justification: null,
  };
}

/** Render the MILESTONES.md chronological index for a manifest (pure). */
export function renderMilestonesIndex(
  paths: RijoPaths,
  manifest: Manifest,
  now: () => Date = () => new Date(),
  closeoutOverride?: Map<string, string>,
): string {
  const rows = manifest.milestones.map((m) => {
    const dir = paths.milestoneDir(m.id, m.slug);
    const closeout = closeoutOverride?.get(m.id) ?? readTextIfExists(path.join(dir, 'CLOSEOUT.md'));
    const baseline = closeout?.match(/baseline_commit: (\S+)/)?.[1] ?? '—';
    return `| ${m.id} | ${m.slug} | ${m.status} | ${baseline === 'null' ? '—' : baseline} |`;
  });
  return [
    '---',
    `active_milestone: ${manifest.active_milestone ?? 'null'}`,
    `updated_at: ${now().toISOString()}`,
    '---',
    '',
    '# Milestones',
    '',
    '| ID | Name | Status | Baseline |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Regenerate the MILESTONES.md chronological index from the manifest. */
export function updateMilestonesIndex(paths: RijoPaths, now: () => Date = () => new Date()): void {
  const manifest = readManifest(paths);
  if (!manifest) return;
  writeFileAtomic(paths.milestonesIndex, renderMilestonesIndex(paths, manifest, now));
  // MILESTONES.md is itself hash-tracked; refresh manifest hashes without structural change
  touchManifest(paths, () => {}, now);
}

/** List milestone directories on disk (for integrity checks). */
export function milestoneDirsOnDisk(paths: RijoPaths): string[] {
  if (!exists(paths.milestonesDir)) return [];
  return fs
    .readdirSync(paths.milestonesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^M\d{3}-/.test(d.name))
    .map((d) => d.name)
    .sort();
}
