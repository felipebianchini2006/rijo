/**
 * Real host integrations: AgentRunners that delegate each RIJO AgentTask to a
 * concrete CLI (Claude Code / Codex) as a headless subprocess. Every model is
 * resolved from config and validated before spawning; every result is parsed
 * from real CLI output — nothing is ever simulated.
 */
export { ClaudeCliRunner, parseClaudeStdout, type ClaudeCliOptions } from './claudeCli.js';
export { CodexCliRunner, parseCodexStdout, type CodexCliOptions, type CodexSandbox } from './codexCli.js';
export { detectClaudeCli, detectCodexCli, type HostAvailability } from './detect.js';
export { validateClaudeModel, validateCodexModel, InvalidModelError, CLAUDE_ALIASES } from './models.js';
export { nodeSpawner, type Spawner, type SpawnRequest, type SpawnResult } from './spawn.js';
export { buildHostPrompt, extractAgentResult, failResult, diagnosticTail } from './parse.js';
