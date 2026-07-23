import { z } from 'zod';
import type { Requirement } from '../core/schemas/index.js';

export const JourneySchema = z.object({
  id: z.string(),
  name: z.string(),
  requirement_ids: z.array(z.string()),
  persona: z.string(),
  critical: z.boolean(),
});
export type Journey = z.infer<typeof JourneySchema>;

export const JourneyResultSchema = z.object({
  journey_id: z.string(),
  passed: z.boolean(),
  steps: z.array(z.string()).default([]),
  console_errors: z.array(z.string()).default([]),
  network_errors: z.array(z.string()).default([]),
  findings: z
    .array(
      z.object({
        severity: z.enum(['blocker', 'critical', 'high', 'medium', 'low']),
        description: z.string(),
        evidence: z.string().nullable().default(null),
      }),
    )
    .default([]),
  screenshots: z.array(z.string()).default([]),
});
export type JourneyResult = z.infer<typeof JourneyResultSchema>;

/**
 * Journeys derive from requirements, never from random exploration.
 * One journey per requirement group (same phase = same functional domain).
 */
export function deriveJourneys(requirements: Requirement[]): Journey[] {
  const byPhase = new Map<string, Requirement[]>();
  for (const r of requirements) {
    if (r.status === 'CANCELLED') continue;
    const key = r.phase ?? 'unassigned';
    const arr = byPhase.get(key) ?? [];
    arr.push(r);
    byPhase.set(key, arr);
  }
  const journeys: Journey[] = [];
  let i = 0;
  for (const [phase, reqs] of [...byPhase.entries()].sort()) {
    i++;
    journeys.push({
      id: `J${String(i).padStart(2, '0')}`,
      name: `Journey for phase ${phase}: ${reqs[0]?.description.slice(0, 50) ?? ''}`,
      requirement_ids: reqs.map((r) => r.id),
      persona: 'real user of the delivered scope',
      critical: reqs.some((r) => !r.description.toLowerCase().includes('nice to have')),
    });
  }
  return journeys;
}
