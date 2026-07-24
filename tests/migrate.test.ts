import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { migrateProject, ensureSchemaCompatible, MigrationError } from '../src/core/migrate.js';
import { SCHEMA_VERSION } from '../src/core/schemas/index.js';
import { RijoPaths } from '../src/core/paths.js';
import { readPlan } from '../src/core/plan.js';
import { detectDrift } from '../src/core/manifest.js';
import { tmpProject, cleanup } from './helpers.js';

function seedV1Project(root: string): RijoPaths {
  const paths = new RijoPaths(root);
  fs.mkdirSync(path.join(root, '.rijo', 'milestones', 'M001-loja', 'phases', '01-catalogo'), { recursive: true });
  fs.writeFileSync(
    paths.manifest,
    JSON.stringify(
      {
        rijo_version: '0.1.0-alpha.1',
        schema_version: 1,
        active_milestone: 'M001',
        milestones: [{ id: 'M001', slug: 'loja', status: 'ACTIVE' }],
        hashes: {},
        updated_at: '2026-07-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(paths.config, 'schema_version: 1\n');
  const planPath = path.join(root, '.rijo', 'milestones', 'M001-loja', 'phases', '01-catalogo', 'PLAN.md');
  fs.writeFileSync(
    planPath,
    [
      '---',
      'phase: "01"',
      'tasks:',
      '  - id: T01',
      '    name: done task',
      '    files: [src/a.ts]',
      '    write_scope: [src/a.ts]',
      '    evidence_expected: e',
      '    technical_justification: legacy',
      '    done: true',
      '  - id: T02',
      '    name: pending task',
      '    files: [src/b.ts]',
      '    write_scope: [src/b.ts]',
      '    evidence_expected: e',
      '    technical_justification: legacy',
      '    done: false',
      '---',
      '',
      '# Plan',
    ].join('\n'),
  );
  return paths;
}

describe('schema migration v1 → v2', () => {
  let root: string;
  beforeEach(() => (root = tmpProject('rijo-mig-')));
  afterEach(() => cleanup(root));

  it('migrates plans (done → status), config and manifest, with backup and no drift', () => {
    const paths = seedV1Project(root);
    const report = migrateProject(paths, () => new Date('2026-07-24T00:00:00.000Z'));
    expect(report.from).toBe(1);
    expect(report.to).toBe(SCHEMA_VERSION);
    expect(fs.existsSync(report.backupDir)).toBe(true);
    // backups of the touched files exist
    expect(fs.readdirSync(report.backupDir).length).toBeGreaterThanOrEqual(3);

    const planPath = path.join(root, '.rijo', 'milestones', 'M001-loja', 'phases', '01-catalogo', 'PLAN.md');
    const plan = readPlan(planPath);
    expect(plan.tasks.find((t) => t.id === 'T01')!.status).toBe('DONE');
    expect(plan.tasks.find((t) => t.id === 'T02')!.status).toBe('PENDING');

    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    expect(manifest.schema_version).toBe(SCHEMA_VERSION);
    expect(fs.readFileSync(paths.config, 'utf8')).toContain(`schema_version: ${SCHEMA_VERSION}`);
    // hashes were refreshed: the migration's own writes are not drift
    const drift = detectDrift(paths);
    expect(drift.drifted).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it('ensureSchemaCompatible is a no-op on current versions and throws on newer', () => {
    const paths = seedV1Project(root);
    expect(ensureSchemaCompatible(paths)).not.toBeNull(); // migrates
    expect(ensureSchemaCompatible(paths)).toBeNull(); // now current
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    manifest.schema_version = 999;
    fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
    expect(() => ensureSchemaCompatible(paths)).toThrow(MigrationError);
  });

  it('an interrupted migration is safely re-runnable (version flips last)', () => {
    const paths = seedV1Project(root);
    // simulate a crash BEFORE the manifest stamp: plans rewritten, version still 1
    const planPath = path.join(root, '.rijo', 'milestones', 'M001-loja', 'phases', '01-catalogo', 'PLAN.md');
    migrateProject(paths); // full migration
    // roll the version back to simulate the crash window, then re-run
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    manifest.schema_version = 1;
    fs.writeFileSync(paths.manifest, JSON.stringify(manifest));
    const report = migrateProject(paths);
    expect(report.to).toBe(SCHEMA_VERSION);
    expect(readPlan(planPath).tasks.find((t) => t.id === 'T01')!.status).toBe('DONE');
  });
});
