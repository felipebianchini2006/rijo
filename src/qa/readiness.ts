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
}

export interface ReadinessDecision {
  status: Readiness;
  reasons: string[];
}

/**
 * READY only when every gate passes. BLOCKED when an indispensable capability
 * is unavailable — never READY by inference.
 */
export function decideReadiness(input: ReadinessInput): ReadinessDecision {
  const reasons: string[] = [];

  if (input.missingCapabilities.length > 0) {
    return {
      status: 'BLOCKED',
      reasons: input.missingCapabilities.map((c) => `Indispensable capability unavailable: ${c}`),
    };
  }

  const failedChecks = input.deterministicChecks.filter((c) => c.exit_code !== 0);
  for (const c of failedChecks) reasons.push(`Check failed: ${c.command} (exit ${c.exit_code})`);

  const buildCheck = input.deterministicChecks.find((c) => /build/.test(c.command));
  if (buildCheck && buildCheck.exit_code !== 0) reasons.push('Production build failing');

  const unmapped = input.requirements.filter(
    (r) => r.status !== 'CANCELLED' && r.status !== 'CARRIED' && !input.journeys.some((j) => j.requirement_ids.includes(r.id)),
  );
  for (const r of unmapped) reasons.push(`Requirement not covered by any journey: ${r.id}`);

  const criticalJourneys = input.journeys.filter((j) => j.critical);
  for (const j of criticalJourneys) {
    const result = input.journeyResults.find((r) => r.journey_id === j.id);
    if (!result) reasons.push(`Critical journey not executed: ${j.id}`);
    else if (!result.passed) reasons.push(`Critical journey failed: ${j.id}`);
    else {
      if (result.console_errors.length > 0)
        reasons.push(`Unhandled console errors in critical flow ${j.id}: ${result.console_errors.length}`);
      if (result.network_errors.length > 0)
        reasons.push(`Network errors (4xx/5xx) in critical flow ${j.id}: ${result.network_errors.length}`);
    }
  }

  for (const result of input.journeyResults) {
    for (const f of result.findings) {
      if (['blocker', 'critical', 'high'].includes(f.severity)) {
        reasons.push(`Open ${f.severity} finding in ${result.journey_id}: ${f.description}`);
      }
    }
  }

  return reasons.length === 0 ? { status: 'READY', reasons: ['All gates passed'] } : { status: 'NOT_READY', reasons };
}
