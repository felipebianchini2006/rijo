import type { AgentTask } from './protocol.js';

/**
 * Compact prompt builder. The brief IS the context: objective, files, scope,
 * acceptance, commands, return format. No repository dumps, no private
 * reasoning requests. Reviewers never receive the author's reasoning.
 */
export function renderBrief(task: AgentTask): string {
  const section = (title: string, lines: string[]) =>
    lines.length ? `## ${title}\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '';
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
