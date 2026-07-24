import * as path from 'node:path';
import { ManifestSchema, SCHEMA_VERSION, type Manifest, type MilestoneStatus } from './schemas/index.js';
import { exists, readJsonIfExists, sha256File, writeJsonAtomic } from './fsx.js';
import type { RijoPaths } from './paths.js';

export const RIJO_VERSION = '0.1.0-alpha.1';

/** Files tracked for drift detection, relative to .rijo/. */
const TRACKED = ['PROJECT.md', 'RULES.md', 'STACK.md', 'MILESTONES.md', 'STATE.md', 'DECISIONS.md', 'config.yml'];

export function computeHashes(paths: RijoPaths): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const rel of TRACKED) {
    const p = path.join(paths.root, rel);
    if (exists(p)) hashes[rel] = sha256File(p);
  }
  return hashes;
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
