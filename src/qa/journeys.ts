import * as fs from 'node:fs';
import * as path from 'node:path';
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

/**
 * Structured, machine-checkable journey action. Playwright specs are
 * generated deterministically from these — never from free-form prose — so a
 * spec either drives the real UI or the journey is BLOCKED for missing
 * actions. `requirement_id` ties each assertion back to the contract.
 */
export const JourneyActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), path: z.string().min(1) }),
  z.object({ action: z.literal('click'), selector: z.string().min(1) }),
  z.object({ action: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
  z.object({ action: z.literal('press'), selector: z.string().min(1), key: z.string().min(1) }),
  z.object({ action: z.literal('expect_visible'), selector: z.string().min(1), requirement_id: z.string().optional() }),
  z.object({ action: z.literal('expect_text'), selector: z.string().min(1), text: z.string().min(1), requirement_id: z.string().optional() }),
  z.object({ action: z.literal('expect_url'), pattern: z.string().min(1), requirement_id: z.string().optional() }),
]);
export type JourneyAction = z.infer<typeof JourneyActionSchema>;

export const JourneyActionsFileSchema = z.object({
  journey_id: z.string(),
  actions: z.array(JourneyActionSchema).min(1),
});
export type JourneyActionsFile = z.infer<typeof JourneyActionsFileSchema>;

/**
 * Load the structured actions for a journey from
 * `<qaDir>/journeys/<id>.actions.json`. Missing or invalid actions return
 * null — the production gate treats that as incomplete configuration
 * (BLOCKED), never as a reason to emit a placeholder spec.
 */
export function loadJourneyActions(qaDir: string, journeyId: string): JourneyActionsFile | null {
  const p = path.join(qaDir, 'journeys', `${journeyId.toLowerCase()}.actions.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JourneyActionsFileSchema.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

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
