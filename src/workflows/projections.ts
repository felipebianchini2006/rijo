import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, exists, readText, writeBufferAtomic, writeFileAtomic } from '../core/fsx.js';
import { activeMilestone } from '../core/milestones.js';
import type { MilestonePaths, RijoPaths } from '../core/paths.js';

/**
 * Keep the canonical, portable active state at the top level of .rijo/.
 * Sealed milestone copies remain immutable history inside milestones/.
 */
export function syncActiveProjectProjections(paths: RijoPaths): void {
  const milestone = activeMilestone(paths);
  if (!milestone) return;

  writeFileAtomic(paths.requirements, readText(milestone.paths.requirements));
  writeFileAtomic(paths.roadmap, readText(milestone.paths.roadmap));
}

/** Project the active quality assurance evidence into the portable top-level state. */
export function syncQaProjections(paths: RijoPaths, milestone: MilestonePaths): void {
  ensureDir(paths.qaDir);
  const journeys = path.join(milestone.qaDir, 'journeys', 'JOURNEYS.md');
  if (exists(journeys)) {
    writeFileAtomic(path.join(paths.qaDir, 'JOURNEYS.md'), readText(journeys));
  }
  copyQaEvidence(
    path.join(milestone.qaDir, 'test-results'),
    path.join(paths.qaDir, 'test-results'),
  );
  if (!exists(milestone.readiness)) return;

  const report = readText(milestone.readiness);
  writeFileAtomic(path.join(paths.qaDir, 'READINESS.md'), report);
  writeFileAtomic(path.join(paths.qaDir, 'TEST-REPORT.md'), report);
  if (!exists(path.join(paths.qaDir, 'FINDINGS.md'))) {
    writeFileAtomic(
      path.join(paths.qaDir, 'FINDINGS.md'),
      '# Findings\n\nSee `TEST-REPORT.md` for the current quality assurance findings.\n',
    );
  }
}

function copyQaEvidence(source: string, destination: string): void {
  if (!exists(source)) return;
  ensureDir(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyQaEvidence(from, to);
    else if (entry.isFile()) writeBufferAtomic(to, fs.readFileSync(from));
  }
}
