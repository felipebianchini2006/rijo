import { z } from 'zod';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import {
  RequirementSchema,
  RoadmapPhaseSchema,
  type Requirement,
  type RoadmapPhase,
} from './schemas/index.js';
import { readText, writeFileAtomic } from './fsx.js';

/**
 * REQUIREMENTS.md and ROADMAP.md keep their machine-readable truth in front
 * matter; the body is a rendered human view regenerated on every write.
 */

const RequirementsDocSchema = z.object({
  milestone: z.string(),
  requirements: z.array(RequirementSchema),
});
export type RequirementsDoc = z.infer<typeof RequirementsDocSchema>;

export function readRequirements(p: string): RequirementsDoc {
  const { data } = parseFrontmatter(readText(p));
  return RequirementsDocSchema.parse(data);
}

export function writeRequirements(p: string, doc: RequirementsDoc): void {
  const body = [
    `# Requirements — ${doc.milestone}`,
    '',
    '| ID | Status | Class | Phase | Description |',
    '|---|---|---|---|---|',
    ...doc.requirements.map(
      (r) =>
        `| ${r.id} | ${r.status} | ${r.classification}${r.carried_from ? ` (from ${r.carried_from})` : ''} | ${r.phase ?? '—'} | ${r.description.replace(/\|/g, '\\|')} |`,
    ),
    '',
  ].join('\n');
  writeFileAtomic(p, serializeFrontmatter(RequirementsDocSchema.parse(doc), body));
}

const RoadmapDocSchema = z.object({
  milestone: z.string(),
  phases: z.array(RoadmapPhaseSchema),
});
export type RoadmapDoc = z.infer<typeof RoadmapDocSchema>;

export function readRoadmap(p: string): RoadmapDoc {
  const { data } = parseFrontmatter(readText(p));
  return RoadmapDocSchema.parse(data);
}

export function writeRoadmap(p: string, doc: RoadmapDoc): void {
  const body = [
    `# Roadmap — ${doc.milestone}`,
    '',
    ...doc.phases.map((ph) => {
      const deps = ph.depends_on.length ? ` (depends on ${ph.depends_on.join(', ')})` : '';
      return [
        `## ${ph.id} — ${ph.name} [${ph.status}]${deps}`,
        '',
        `Requirements: ${ph.requirements.join(', ') || 'none (technical)'}`,
        ph.commit ? `Commit: ${ph.commit}` : '',
        '',
      ]
        .filter(Boolean)
        .join('\n');
    }),
  ].join('\n');
  writeFileAtomic(p, serializeFrontmatter(RoadmapDocSchema.parse(doc), body));
}

/** Phase ready set: PENDING phases whose dependencies are all DONE. */
export function readyPhases(doc: RoadmapDoc): RoadmapPhase[] {
  const done = new Set(doc.phases.filter((p) => p.status === 'DONE').map((p) => p.id));
  return doc.phases.filter(
    (p) => p.status === 'PENDING' && p.depends_on.every((d) => done.has(d)),
  );
}

export function nextPhase(doc: RoadmapDoc): RoadmapPhase | null {
  const inProgress = doc.phases.find((p) => p.status === 'IN_PROGRESS');
  if (inProgress) return inProgress;
  const ready = readyPhases(doc);
  return ready[0] ?? null;
}

export function requirementIds(reqs: Requirement[]): Set<string> {
  return new Set(reqs.map((r) => r.id));
}
