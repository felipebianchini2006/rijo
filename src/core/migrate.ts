import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { SCHEMA_VERSION } from './schemas/index.js';
import { ensureDir, exists, readJsonIfExists, readText, sha256, sha256File, writeFileAtomic, writeJsonAtomic } from './fsx.js';
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
 * v1/v2/v3 → v4:
 *  - PLAN.md tasks gain `status` (derived from the legacy `done` flag);
 *  - legacy task files are explicitly migrated to intent-bearing references;
 *  - legacy plans receive an invalid freshness stamp, forcing safe re-planning;
 *  - config.yml receives the v4 stamp; the autonomous decision policy and
 *    codebase-map defaults materialize deterministically through ConfigSchema;
 *  - manifest.schema_version becomes 4.
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
      if (!Array.isArray(t['mapped_references'])) {
        const files = Array.isArray(t['files']) ? t['files'].filter((entry): entry is string => typeof entry === 'string') : [];
        t['mapped_references'] = files.map((file) => {
          const normalized = file.replace(/\\/g, '/').replace(/^\.\/+/, '');
          const absolute = path.resolve(paths.projectRoot, normalized);
          const rel = path.relative(paths.projectRoot, absolute);
          if (!path.isAbsolute(rel) && !rel.startsWith('..') && exists(absolute) && fs.statSync(absolute).isFile()) {
            return { path: normalized, intent: 'existing', file_hash: sha256File(absolute) };
          }
          return {
            path: normalized,
            intent: 'new',
            parent_module: 'legacy-unmapped',
            placement_evidence: [{ path: '.', reason: 'explicit legacy migration; freshness gate requires re-planning' }],
          };
        });
      }
    }
    const invalidationSeed = sha256(`legacy-plan-migration\0${path.relative(paths.root, planPath)}`);
    data['mapped_commit'] = typeof data['mapped_commit'] === 'string' ? data['mapped_commit'] : 'legacy-unmapped';
    data['mapped_tree_hash'] = typeof data['mapped_tree_hash'] === 'string' ? data['mapped_tree_hash'] : invalidationSeed;
    data['planned_at'] = typeof data['planned_at'] === 'string' ? data['planned_at'] : now().toISOString();
    data['context_packet_hash'] =
      typeof data['context_packet_hash'] === 'string' ? data['context_packet_hash'] : invalidationSeed;
    data['mapped_reference_hashes'] =
      data['mapped_reference_hashes'] && typeof data['mapped_reference_hashes'] === 'object'
        ? data['mapped_reference_hashes']
        : {};
    data['decision_context_hash'] =
      typeof data['decision_context_hash'] === 'string' ? data['decision_context_hash'] : invalidationSeed;
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
