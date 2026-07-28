import * as fs from 'node:fs';
import * as path from 'node:path';
import { ManifestSchema, SCHEMA_VERSION, type Manifest, type MilestoneStatus } from './schemas/index.js';
import { exists, readJsonIfExists, sha256, sha256File, writeJsonAtomic } from './fsx.js';
import type { RijoPaths } from './paths.js';

export const RIJO_VERSION = '0.2.0-rc.1';

/** Global files tracked for drift detection, relative to .rijo/. */
const TRACKED = [
  'PROJECT.md',
  'REQUIREMENTS.md',
  'ROADMAP.md',
  'STACK.md',
  'ARCHITECTURE.md',
  'INTEGRATIONS.md',
  'RULES.md',
  'MILESTONES.md',
  'STATE.md',
  'DECISIONS.md',
  'config.yml',
];

/** Per-milestone canonical artifacts tracked for drift. */
const MILESTONE_TRACKED = ['SCOPE.md', 'REQUIREMENTS.md', 'ROADMAP.md', 'RESEARCH.md', 'CLOSEOUT.md'];

/** Per-phase canonical artifacts tracked for drift. */
const PHASE_TRACKED = [
  'RESEARCH.md',
  'SPEC.md',
  'PLAN.md',
  'VERIFICATION.md',
  'REVIEW.md',
  'UI-SMOKE.json',
];

/**
 * Overlay of not-yet-written contents keyed by path relative to `.rijo/`.
 * Lets a transaction compute the FINAL hash map before anything durable
 * changes (crash-safe staging).
 */
export type HashOverlay = Map<string, string>;

/**
 * Hash the ENTIRE relevant canonical context: global files, the active
 * milestone's requirements/roadmap/specs/plans/verifications, decisions,
 * configuration and research sources. Any change outside the core is drift.
 * With an overlay, staged contents take precedence over the disk.
 */
export function computeHashes(paths: RijoPaths, overlay?: HashOverlay): Record<string, string> {
  const hashes: Record<string, string> = {};
  const hashOf = (rel: string): string | null => {
    if (overlay?.has(rel)) return sha256(overlay.get(rel)!);
    const p = path.join(paths.root, rel);
    return exists(p) ? sha256File(p) : null;
  };
  for (const rel of TRACKED) {
    const h = hashOf(rel);
    if (h) hashes[rel] = h;
  }
  {
    const h = hashOf('research/sources.json');
    if (h) hashes['research/sources.json'] = h;
  }

  const rawManifest = overlay?.has('manifest.json')
    ? (JSON.parse(overlay.get('manifest.json')!) as { active_milestone?: string | null; milestones?: Array<{ id: string; slug: string }> })
    : readJsonIfExists<{ active_milestone?: string | null; milestones?: Array<{ id: string; slug: string }> }>(paths.manifest);
  const active = rawManifest?.active_milestone
    ? rawManifest.milestones?.find((m) => m.id === rawManifest.active_milestone)
    : null;
  if (active) {
    const mdir = paths.milestoneDir(active.id, active.slug);
    const mrel = path.relative(paths.root, mdir).split(path.sep).join('/');
    for (const f of MILESTONE_TRACKED) {
      const h = hashOf(`${mrel}/${f}`);
      if (h) hashes[`${mrel}/${f}`] = h;
    }
    const phasesDir = path.join(mdir, 'phases');
    if (exists(phasesDir)) {
      for (const entry of fs.readdirSync(phasesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        for (const f of PHASE_TRACKED) {
          const h = hashOf(`${mrel}/phases/${entry.name}/${f}`);
          if (h) hashes[`${mrel}/phases/${entry.name}/${f}`] = h;
        }
      }
    }
  }
  return hashes;
}

/**
 * Deterministic digest of the whole canonical context. Every AgentTask carries
 * this at dispatch; a result is only applicable while the digest is unchanged.
 */
export function canonicalBaselineHash(paths: RijoPaths): string {
  const hashes = computeHashes(paths);
  const sorted = Object.keys(hashes)
    .sort()
    .map((k) => `${k}:${hashes[k]}`)
    .join('\n');
  return sha256(sorted);
}

export function readManifest(paths: RijoPaths): Manifest | null {
  const raw = readJsonIfExists<unknown>(paths.manifest);
  if (raw === null) return null;
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`manifest.json is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export class SchemaMismatchError extends Error {
  constructor(
    public readonly found: number,
    public readonly supported: number,
  ) {
    super(
      `manifest schema_version ${found} is not supported by this RIJO build (supports ${supported}). ` +
        `Back up .rijo/, run a migration, and re-validate before continuing.`,
    );
    this.name = 'SchemaMismatchError';
  }
}

/**
 * Compare the on-disk schema version with the version this build supports.
 * A newer schema must not be run by an older build; an older schema is a
 * migration point. Callers surface this before mutating any workflow state.
 */
export function checkSchemaCompatibility(paths: RijoPaths): void {
  const raw = readJsonIfExists<{ schema_version?: number }>(paths.manifest);
  if (raw === null) return;
  if (typeof raw.schema_version === 'number' && raw.schema_version !== SCHEMA_VERSION) {
    throw new SchemaMismatchError(raw.schema_version, SCHEMA_VERSION);
  }
}

export function writeManifest(paths: RijoPaths, manifest: Manifest): void {
  writeJsonAtomic(paths.manifest, ManifestSchema.parse(manifest));
}

export function newManifest(now: () => Date = () => new Date()): Manifest {
  return {
    rijo_version: RIJO_VERSION,
    schema_version: SCHEMA_VERSION,
    active_milestone: null,
    milestones: [],
    hashes: {},
    updated_at: now().toISOString(),
  };
}

/** Refresh hashes and timestamp after a canonical write. */
export function touchManifest(
  paths: RijoPaths,
  mutate: (m: Manifest) => void = () => {},
  now: () => Date = () => new Date(),
): Manifest {
  const m = readManifest(paths) ?? newManifest(now);
  mutate(m);
  m.hashes = computeHashes(paths);
  m.updated_at = now().toISOString();
  writeManifest(paths, m);
  return m;
}

export interface DriftReport {
  drifted: string[];
  missing: string[];
}

/** Compare current file hashes against the manifest. Unacknowledged drift blocks runs. */
export function detectDrift(paths: RijoPaths): DriftReport {
  const m = readManifest(paths);
  if (!m) return { drifted: [], missing: [] };
  const current = computeHashes(paths);
  const drifted: string[] = [];
  const missing: string[] = [];
  for (const [rel, hash] of Object.entries(m.hashes)) {
    if (!(rel in current)) missing.push(rel);
    else if (current[rel] !== hash) drifted.push(rel);
  }
  return { drifted, missing };
}

export function setMilestoneStatus(m: Manifest, id: string, status: MilestoneStatus): void {
  const entry = m.milestones.find((x) => x.id === id);
  if (!entry) throw new Error(`Milestone ${id} not found in manifest`);
  entry.status = status;
}
