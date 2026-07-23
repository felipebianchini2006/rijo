import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import { StateFrontmatterSchema, type StateFrontmatter } from './schemas/index.js';
import { readTextIfExists, writeFileAtomic } from './fsx.js';
import type { RijoPaths } from './paths.js';

/**
 * STATE.md is the durable checkpoint: active milestone/phase/task, last
 * verified work, next step and blockers. It only advances on verified
 * checkpoints — never on optimistic progress.
 */

export function readState(paths: RijoPaths): StateFrontmatter | null {
  const raw = readTextIfExists(paths.state);
  if (raw === null) return null;
  const { data } = parseFrontmatter(raw);
  const parsed = StateFrontmatterSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function writeState(
  paths: RijoPaths,
  state: StateFrontmatter,
  narrative: string,
): void {
  const body = [
    '# STATE',
    '',
    narrative.trim(),
    '',
    `- Next step: ${state.next_step ?? 'n/a'}`,
    state.blocked ? `- BLOCKED: ${state.blocked_reason ?? 'unspecified'}` : '- No blockers.',
    '',
  ].join('\n');
  writeFileAtomic(paths.state, serializeFrontmatter(StateFrontmatterSchema.parse(state), body));
}

export function initialState(now: () => Date = () => new Date()): StateFrontmatter {
  return {
    milestone: null,
    phase: null,
    task: null,
    stage: null,
    last_verified: null,
    last_commit: null,
    next_step: null,
    blocked: false,
    blocked_reason: null,
    updated_at: now().toISOString(),
  };
}
