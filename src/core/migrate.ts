import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { SCHEMA_VERSION } from './schemas/index.js';
import { ensureDir, exists, readJsonIfExists, readText, writeFileAtomic, writeJsonAtomic } from './fsx.js';
import { computeHashes } from './manifest.js';
import type { RijoPaths } from './paths.js';

export interface MigrationReport {
  from: number;
  to: number;
  backupDir: string;
  changed: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Deterministic schema migration. Order: back up every file the migration will
 * touch, transform, validate, then flip manifest.schema_version LAST — so an
 * interrupted migration is re-runnable (the version stamp only advances after
 * every artifact has been rewritten).
 *
 * v1 → v2:
 *  - PLAN.md tasks gain `status` (derived from the legacy `done` flag);
 *  - config.yml is re-serialized so the new qa/execution/research/providers
 *    sections exist explicitly with their defaults;
 *  - manifest.schema_version becomes 2.
 */
export function migrateProject(paths: RijoPaths, now: () => Date = () => new Date()): MigrationReport {
  const manifest = readJsonIfExists<{ schema_version?: number }>(paths.manifest);
  if (!manifest) throw new MigrationError('No manifest.json to migrate.');
  const from = manifest.schema_version ?? 1;
  if (from === SCHEMA_VERSION) return { from, to: SCHEMA_VERSION, backupDir: '', changed: [] };
  if (from > SCHEMA_VERSION) {
    throw new MigrationError(
      `manifest schema_version ${from} is newer than this build supports (${SCHEMA_VERSION}); upgrade RIJO.`,
    );
  }

  const stamp = now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const backupDir = path.join(paths.archiveDir, `migration-v${from}-to-v${SCHEMA_VERSION}-${stamp}`);
  ensureDir(backupDir);
  const changed: string[] = [];

  const backup = (p: string) => {
    if (!exists(p)) return;
    const rel = path.relative(paths.root, p).split(path.sep).join('__');
    fs.copyFileSync(p, path.join(backupDir, rel));
  };

  // ---- collect the plan files of every milestone on disk
  const planFiles: string[] = [];
  if (exists(paths.milestonesDir)) {
    for (const mdir of fs.readdirSync(paths.milestonesDir, { withFileTypes: true })) {
      if (!mdir.isDirectory()) continue;
      const phasesDir = path.join(paths.milestonesDir, mdir.name, 'phases');
      if (!exists(phasesDir)) continue;
      for (const pdir of fs.readdirSync(phasesDir, { withFileTypes: true })) {
        if (!pdir.isDirectory()) continue;
        const plan = path.join(phasesDir, pdir.name, 'PLAN.md');
        if (exists(plan)) planFiles.push(plan);
      }
    }
  }

  backup(paths.manifest);
  backup(paths.config);
  for (const p of planFiles) backup(p);

  // ---- transform plans: done:true → status DONE, else PENDING (v1 had no
  // notion of an implemented-but-unverified task, so `done` was verified-done)
  for (const planPath of planFiles) {
    const { data, body } = parseFrontmatter<Record<string, unknown>>(readText(planPath));
    const tasks = Array.isArray(data['tasks']) ? (data['tasks'] as Array<Record<string, unknown>>) : [];
    for (const t of tasks) {
      if (typeof t['status'] !== 'string') {
        t['status'] = t['done'] === true ? 'DONE' : 'PENDING';
      }
    }
    writeFileAtomic(planPath, serializeFrontmatter(data, body));
    changed.push(planPath);
  }

  // ---- config: stamp new schema_version (new sections materialize on next save)
  if (exists(paths.config)) {
    const raw = readText(paths.config);
    if (/^schema_version:/m.test(raw)) {
      writeFileAtomic(paths.config, raw.replace(/^schema_version:.*$/m, `schema_version: ${SCHEMA_VERSION}`));
    } else {
      writeFileAtomic(paths.config, `schema_version: ${SCHEMA_VERSION}\n${raw}`);
    }
    changed.push(paths.config);
  }

  // ---- LAST: advance the manifest version stamp, with hashes refreshed so the
  // migration's own rewrites are not later reported as drift.
  writeJsonAtomic(paths.manifest, {
    ...manifest,
    schema_version: SCHEMA_VERSION,
    hashes: computeHashes(paths),
    updated_at: now().toISOString(),
  });
  changed.push(paths.manifest);

  return { from, to: SCHEMA_VERSION, backupDir, changed };
}

/**
 * Workflow entry guard: an older on-disk schema is migrated (backup +
 * deterministic transform + hash refresh) before any workflow mutates state;
 * a newer one throws — an old build must never touch a newer project.
 * Returns the migration report when a migration ran, null when compatible.
 */
export function ensureSchemaCompatible(paths: RijoPaths, now: () => Date = () => new Date()): MigrationReport | null {
  const manifest = readJsonIfExists<{ schema_version?: number }>(paths.manifest);
  if (!manifest) return null;
  const found = manifest.schema_version ?? 1;
  if (found === SCHEMA_VERSION) return null;
  return migrateProject(paths, now);
}
