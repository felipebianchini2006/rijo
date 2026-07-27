import type { CommandEvidence } from '../core/commands.js';
import type { Requirement, Readiness } from '../core/schemas/index.js';
import type { Journey, JourneyResult } from './journeys.js';

export interface ReadinessInput {
  commit: string | null;
  environment: string;
  deterministicChecks: CommandEvidence[];
  requirements: Requirement[];
  journeys: Journey[];
  journeyResults: JourneyResult[];
  missingCapabilities: string[];
  fixesApplied: string[];
  /** requirements considered first-version scope (must be DONE for READY). */
  firstVersion?: boolean;
  /** journey ids explicitly waived, with an auditable reason. */
  waivers?: Array<{ journey_id: string; reason: string }>;
  /** true when a production build script exists in the project. */
  hasBuild?: boolean;
}

export interface ReadinessDecision {
  status: Readiness;
  reasons: string[];
}

/**
 * READY only when EVERY gate passes. BLOCKED when an indispensable capability
 * is unavailable — never READY by inference.
 */
export function decideReadiness(input: ReadinessInput): ReadinessDecision {
  const reasons: string[] = [];
  const waived = new Set((input.waivers ?? []).map((w) => w.journey_id));

  if (input.missingCapabilities.length > 0) {
    return {
      status: 'BLOCKED',
      reasons: input.missingCapabilities.map((c) => `Indispensable capability unavailable: ${c}`),
    };
  }

  // A pinned commit is mandatory: a readiness report must reference the exact
  // build it evaluated.
  if (!input.commit) reasons.push('No pinned commit — cannot certify a specific build.');

  // Any failed deterministic check blocks.
  for (const c of input.deterministicChecks.filter((c) => c.blocked)) {
    reasons.push(`Check blocked by policy: ${c.command}`);
  }
  for (const c of input.deterministicChecks.filter((c) => c.exit_code !== 0 && !c.blocked)) {
    reasons.push(`Check failed: ${c.command} (exit ${c.exit_code})`);
  }

  // Run and enforce a production build when the project declares one.
  const buildCheck = input.deterministicChecks.find((c) => /\bbuild\b/.test(c.command));
  if (input.hasBuild && !buildCheck) reasons.push('The declared production build did not run.');
  else if (buildCheck && buildCheck.exit_code !== 0) reasons.push('Production build failing');

  // Requirement gate: every active requirement must be covered by a journey,
  // AND (for a first-version certification) be DONE — a PENDING requirement can
  // never satisfy the gate just by being mapped.
  const active = input.requirements.filter((r) => r.status !== 'CANCELLED' && r.status !== 'CARRIED');
  for (const r of active) {
    if (!input.journeys.some((j) => j.requirement_ids.includes(r.id))) {
      reasons.push(`Requirement not covered by any journey: ${r.id}`);
    }
    if (input.firstVersion !== false && r.status !== 'DONE' && r.status !== 'DEBT') {
      reasons.push(`Requirement ${r.id} is ${r.status}, not DONE — first-version scope incomplete.`);
    }
  }

  // Journey gate: EVERY journey must pass (not only critical ones), unless it
  // carries an explicit, auditable waiver.
  for (const j of input.journeys) {
    if (waived.has(j.id)) continue;
    const result = input.journeyResults.find((r) => r.journey_id === j.id);
    if (!result) reasons.push(`Journey not executed: ${j.id}`);
    else if (!result.passed) reasons.push(`Journey failed: ${j.id}`);
    else {
      if (result.console_errors.length > 0)
        reasons.push(`Unhandled console errors in ${j.id}: ${result.console_errors.length}`);
      if (result.network_errors.length > 0)
        reasons.push(`Network errors (4xx/5xx) in ${j.id}: ${result.network_errors.length}`);
    }
  }

  // Any open blocker/critical/high finding blocks.
  for (const result of input.journeyResults) {
    for (const f of result.findings) {
      if (['blocker', 'critical', 'high'].includes(f.severity)) {
        reasons.push(`Open ${f.severity} finding in ${result.journey_id}: ${f.description}`);
      }
    }
  }

  return reasons.length === 0 ? { status: 'READY', reasons: ['All gates passed'] } : { status: 'NOT_READY', reasons };
}
