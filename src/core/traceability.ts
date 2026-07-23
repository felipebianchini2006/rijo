import * as fs from 'node:fs';
import * as path from 'node:path';
import { exists } from './fsx.js';
import type { Requirement, RoadmapPhase, PhasePlan } from './schemas/index.js';
import type { RijoPaths } from './paths.js';
import { readState } from './state.js';
import { detectDrift, readManifest } from './manifest.js';
import { scopesOverlap } from './plan.js';

export interface TraceIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  fix: string;
}

/**
 * Deterministic traceability validation. Every rule here corresponds to a
 * mandatory failure mode from the RIJO contract:
 *  - orphan requirement (in no phase)
 *  - task without requirement or technical justification
 *  - completed phase without evidence
 *  - completed requirement without test or explicit justification
 *  - parallel workers with conflicting write scopes
 *  - state pointing at a missing artifact
 *  - unacknowledged manifest drift
 */
export function validateTraceability(input: {
  requirements: Requirement[];
  phases: RoadmapPhase[];
  plans?: Map<string, PhasePlan>;
  milestoneDir?: string;
}): TraceIssue[] {
  const issues: TraceIssue[] = [];
  const phaseIds = new Set(input.phases.map((p) => p.id));

  for (const req of input.requirements) {
    const active = req.status !== 'CANCELLED' && req.status !== 'CARRIED';
    if (active && (!req.phase || !phaseIds.has(req.phase))) {
      issues.push({
        code: 'ORPHAN_REQUIREMENT',
        severity: 'error',
        message: `Requirement ${req.id} is not mapped to any phase`,
        fix: 'Assign the requirement to exactly one main phase in ROADMAP.md',
      });
    }
    if (req.status === 'DONE') {
      if (req.tests.length === 0 && !req.no_test_justification) {
        issues.push({
          code: 'DONE_WITHOUT_TEST',
          severity: 'error',
          message: `Requirement ${req.id} is DONE but has no test and no explicit justification`,
          fix: 'Link a test or record no_test_justification',
        });
      }
      if (!req.evidence) {
        issues.push({
          code: 'DONE_WITHOUT_EVIDENCE',
          severity: 'error',
          message: `Requirement ${req.id} is DONE but has no evidence`,
          fix: 'Record the verification evidence (command, exit code, commit)',
        });
      }
    }
  }

  for (const phase of input.phases) {
    const mapped = input.requirements.filter((r) => r.phase === phase.id).map((r) => r.id);
    for (const rid of phase.requirements) {
      if (!input.requirements.some((r) => r.id === rid)) {
        issues.push({
          code: 'PHASE_UNKNOWN_REQ',
          severity: 'error',
          message: `Phase ${phase.id} lists unknown requirement ${rid}`,
          fix: 'Remove the stale ID or add the requirement',
        });
      }
    }
    if (phase.status === 'DONE' && input.milestoneDir) {
      const verification = path.join(input.milestoneDir, 'phases');
      const dir = findPhaseDir(verification, phase.id);
      if (!dir || !exists(path.join(dir, 'VERIFICATION.md'))) {
        issues.push({
          code: 'PHASE_DONE_WITHOUT_EVIDENCE',
          severity: 'error',
          message: `Phase ${phase.id} is DONE but has no VERIFICATION.md`,
          fix: 'A phase can only be DONE after VERIFY produced evidence',
        });
      }
    }
    void mapped;
  }

  if (input.plans) {
    for (const [phaseId, plan] of input.plans) {
      const parallel = plan.tasks.filter((t) => t.parallel);
      for (let i = 0; i < parallel.length; i++) {
        for (let j = i + 1; j < parallel.length; j++) {
          const a = parallel[i]!;
          const b = parallel[j]!;
          const independent = !a.depends_on.includes(b.id) && !b.depends_on.includes(a.id);
          if (independent && scopesOverlap(a.write_scope, b.write_scope)) {
            issues.push({
              code: 'PARALLEL_WRITE_CONFLICT',
              severity: 'error',
              message: `Phase ${phaseId}: parallel tasks ${a.id} and ${b.id} share write scope`,
              fix: 'Serialize the tasks or disjoin their write scopes',
            });
          }
        }
      }
    }
  }

  return issues;
}

/** Validate that STATE.md points at artifacts that exist and drift is acknowledged. */
export function validateStateIntegrity(paths: RijoPaths): TraceIssue[] {
  const issues: TraceIssue[] = [];
  const state = readState(paths);
  const manifest = readManifest(paths);
  if (state?.milestone && manifest) {
    const entry = manifest.milestones.find((m) => m.id === state.milestone);
    if (!entry) {
      issues.push({
        code: 'STATE_UNKNOWN_MILESTONE',
        severity: 'error',
        message: `STATE.md points at milestone ${state.milestone} which is not in the manifest`,
        fix: 'Repair STATE.md or the manifest',
      });
    } else {
      const dir = paths.milestoneDir(entry.id, entry.slug);
      if (!exists(dir)) {
        issues.push({
          code: 'STATE_MISSING_ARTIFACT',
          severity: 'error',
          message: `STATE.md points at ${dir} which does not exist`,
          fix: 'Restore the milestone directory or repair STATE.md',
        });
      }
    }
  }
  const drift = detectDrift(paths);
  for (const f of drift.drifted) {
    issues.push({
      code: 'DRIFT',
      severity: 'error',
      message: `${f} changed outside RIJO (hash mismatch with manifest)`,
      fix: 'Review the change, then re-run with acknowledgement (rijo touches the manifest after canonical writes)',
    });
  }
  for (const f of drift.missing) {
    issues.push({
      code: 'DRIFT_MISSING',
      severity: 'error',
      message: `${f} tracked by the manifest is missing`,
      fix: 'Restore the file from git or re-initialize the artifact',
    });
  }
  return issues;
}

function findPhaseDir(phasesRoot: string, phaseId: string): string | null {
  if (!exists(phasesRoot)) return null;
  const entry = fs.readdirSync(phasesRoot).find((d) => d.startsWith(`${phaseId}-`) || d === phaseId);
  return entry ? path.join(phasesRoot, entry) : null;
}
