/**
 * Provider-specific model validation. A configured model is checked *before*
 * any process is spawned, so an operator typo (or an abstract RIJO tier string
 * leaking into the model field) fails with a clear message instead of a cryptic
 * CLI error after the fact.
 */

export class InvalidModelError extends Error {
  constructor(provider: 'claude' | 'codex', model: string, hint: string) {
    super(`Invalid ${provider} model "${model}". ${hint}`);
    this.name = 'InvalidModelError';
  }
}

/** Claude Code model aliases documented at https://code.claude.com/docs/en/cli-reference. */
export const CLAUDE_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/**
 * Accept a Claude alias (opus/sonnet/haiku/fable), a `claude-*` model id, or a
 * cloud-provider prefixed id (Bedrock/Vertex `region.anthropic.*`). Reject
 * everything else — most importantly the abstract RIJO tier strings
 * (strongest, economical-coding, …) which must never reach `--model`.
 */
export function validateClaudeModel(model: string): void {
  const m = model.trim();
  if (
    (CLAUDE_ALIASES as readonly string[]).includes(m) ||
    /^claude-/.test(m) ||
    /^[a-z]+\.anthropic\./.test(m)
  ) {
    return;
  }
  throw new InvalidModelError(
    'claude',
    model,
    `Expected an alias (${CLAUDE_ALIASES.join('/')}) or a "claude-*" model id.`,
  );
}

/**
 * Accept a Codex model id: the `gpt-*` line (e.g. gpt-5.6-sol), the legacy
 * reasoning `o*` line (o3, o4-mini), or an explicit `codex-*` id. Reject RIJO
 * tier placeholders and empty strings.
 */
export function validateCodexModel(model: string): void {
  const m = model.trim();
  if (/^gpt-/.test(m) || /^o\d/.test(m) || /^codex-/.test(m)) return;
  throw new InvalidModelError(
    'codex',
    model,
    'Expected a "gpt-*" (e.g. gpt-5.6-sol), "o*", or "codex-*" model id.',
  );
}
