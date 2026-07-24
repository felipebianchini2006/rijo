import type { AgentTask } from './protocol.js';
import { renderProfileBrief } from '../experts/embed.js';
import { validateProfiles } from '../experts/router.js';

/**
 * Compact prompt builder. The brief IS the context: objective, files, scope,
 * acceptance, commands, return format. No repository dumps, no private
 * reasoning requests. Reviewers never receive the author's reasoning.
 *
 * When `task.expert_profiles` is non-empty, an `## Expert guidance` section
 * is injected (embed mode) with the compact brief for each selected profile.
 * Invalid profile ids throw BEFORE any brief is produced — never sent to a
 * model.
 */
export function renderBrief(task: AgentTask): string {
  const section = (title: string, lines: string[]) =>
    lines.length ? `## ${title}\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '';
  const profiles = task.expert_profiles ?? [];
  if (profiles.length > 0) validateProfiles(profiles);
  const expertGuidance = profiles.length > 0 ? `## Expert guidance\n${renderProfileBrief(profiles)}\n` : '';
  return [
    `# ${task.role.toUpperCase()} task ${task.id}`,
    '',
    `## Objective`,
    task.objective,
    '',
    section('Canonical files (read these first)', task.canonical_files),
    section('Relevant code files', task.code_files),
    section('Write scope (you may ONLY write these)', task.write_scope),
    section('Acceptance criteria', task.acceptance_criteria),
    section('Verification commands', task.verification_commands),
    expertGuidance,
    `## Return format`,
    task.return_format,
    task.notes ? `\n## Notes\n${task.notes}` : '',
    '',
    'Rules: write outputs to disk inside your write scope; return only a short summary.',
    'Do not mark anything complete without evidence. If blocked, say precisely why.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}
