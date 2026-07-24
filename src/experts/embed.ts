import type { AgentTaskDraft } from '../agents/protocol.js';
import { EXPERT_PROFILE_MAP } from './catalog.js';
import { validateProfiles } from './router.js';

/**
 * Render a compact text block (mission + checklist + anti-patterns + output
 * contract) for the given profile ids, in the order given. This is the SAME
 * source both the `embed` mode (injected into `renderBrief`) and the
 * `.claude`/`.agents` adapters read from — never duplicated content.
 */
export function renderProfileBrief(profileIds: string[]): string {
  if (profileIds.length === 0) return '';
  validateProfiles(profileIds);
  return profileIds
    .map((id) => {
      const p = EXPERT_PROFILE_MAP.get(id)!;
      const checklist = p.checklist.map((c) => `- ${c}`).join('\n');
      const antiPatterns = p.anti_patterns.map((a) => `- ${a}`).join('\n');
      return [
        `### ${p.id}`,
        p.mission,
        'Checklist:',
        checklist,
        'Avoid:',
        antiPatterns,
        `Output contract: ${p.output_contract}`,
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * Build a read-only advisory task draft for `consult` mode: a single expert
 * profile reviews a context note and returns a short structured verdict. The
 * caller (orchestrator) MUST assign a real `id` and `attempt` before
 * dispatch — this draft carries a stable placeholder id only.
 */
export function buildConsultAdvisoryTask(profileId: string, contextNote: string): AgentTaskDraft {
  validateProfiles([profileId]);
  return {
    id: `consult-${profileId}`,
    role: 'reviewer',
    objective: `Advisory review from the ${profileId} perspective: ${contextNote}`,
    canonical_files: [],
    code_files: [],
    write_scope: [],
    acceptance_criteria: [],
    verification_commands: [],
    return_format:
      'JSON advisory verdict only: { "concerns": string[], "recommendations": string[], "severity": "low"|"medium"|"high"|"critical" }',
    notes: renderProfileBrief([profileId]),
    workspace: null,
    canonical_baseline: null,
    attempt: null,
    expert_profiles: [profileId],
  };
}
