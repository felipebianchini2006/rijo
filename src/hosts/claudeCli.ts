import type { AgentRunner, RunnerCapabilities } from '../agents/runner.js';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { RijoConfig } from '../core/schemas/index.js';
import { resolveClaudeTier } from '../agents/roles.js';
import { nodeSpawner, type Spawner } from './spawn.js';
import { validateClaudeModel } from './models.js';
import { buildHostPrompt, extractAgentResult, diagnosticTail, failResult } from './parse.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: true, browser: false };

export interface ClaudeCliOptions {
  /** Project root; also the fallback cwd when a task has no isolated workspace. */
  projectRoot: string;
  config: RijoConfig;
  /** Injectable process spawner (real by default; faked in tests). */
  spawner?: Spawner;
  timeoutMs?: number;
  /** Override reported capabilities. `browser` stays false unless truly wired. */
  capabilities?: Partial<RunnerCapabilities>;
  /** Binary name/path. Default 'claude'. */
  bin?: string;
  /**
   * Permission posture for headless writes. 'acceptEdits' lets the agent write
   * files (and common fs commands) without prompting — the RIJO default. A host
   * that trusts the sandbox may pass 'bypassPermissions'.
   */
  permissionMode?: string;
  /** Extra tools to auto-approve, e.g. ['Bash','Read','Edit']. */
  allowedTools?: string[];
}

/**
 * AgentRunner backed by the Claude Code CLI in headless/print mode.
 *
 * Flags (verified 2026-07-24 against https://code.claude.com/docs/en/headless
 * and https://code.claude.com/docs/en/cli-reference):
 *   -p / --print              non-interactive
 *   --output-format json      structured envelope with a `result` text field
 *   --model <alias|claude-*>  concrete model from providers.claude[tier]
 *   --effort <low|medium|high>  reasoning effort from the tier
 *   --permission-mode <mode>  headless permission posture
 *   --allowedTools <list>     auto-approved tools (optional)
 *   --add-dir <path>          grant read access to the project root when the
 *                             task runs inside an isolated workspace
 *
 * The concrete model is resolved from config (never the abstract tier) and
 * validated before spawning. Output is parsed from the JSON envelope's `result`
 * text (or `structured_output`) into an AgentResult; unparseable output becomes
 * an explicit ok:false — the driver never simulates a result.
 */
export class ClaudeCliRunner implements AgentRunner {
  public readonly capabilities: RunnerCapabilities;
  private readonly spawner: Spawner;
  private readonly timeoutMs: number;
  private readonly bin: string;
  private readonly permissionMode: string;
  private readonly allowedTools: string[];
  private readonly projectRoot: string;
  private readonly config: RijoConfig;

  constructor(opts: ClaudeCliOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.spawner = opts.spawner ?? nodeSpawner;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bin = opts.bin ?? 'claude';
    this.permissionMode = opts.permissionMode ?? 'acceptEdits';
    this.allowedTools = opts.allowedTools ?? [];
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    let model: string;
    let effort: string;
    try {
      const tierName = task.tier ?? this.config.models[task.role];
      const tier = resolveClaudeTier(this.config, tierName, task.role);
      validateClaudeModel(tier.model);
      model = tier.model;
      effort = tier.effort;
    } catch (err) {
      return failResult(task.id, err instanceof Error ? err.message : String(err));
    }

    const cwd = task.workspace?.root ?? this.projectRoot;
    const args = [
      '-p',
      buildHostPrompt(task),
      '--output-format',
      'json',
      '--model',
      model,
      '--effort',
      effort,
      '--permission-mode',
      this.permissionMode,
    ];
    if (this.allowedTools.length) args.push('--allowedTools', this.allowedTools.join(','));
    // When working inside an isolated workspace, the canonical .rijo files the
    // brief points to live under the project root — grant read access to them.
    if (cwd !== this.projectRoot) args.push('--add-dir', this.projectRoot);

    const res = await this.spawner({ command: this.bin, args, cwd, timeoutMs: this.timeoutMs });

    if (res.spawnError) {
      return failResult(
        task.id,
        `Claude CLI could not be started (${res.spawnError}). Is "${this.bin}" installed and on PATH?`,
      );
    }
    if (res.timedOut) {
      return failResult(task.id, `Claude CLI timed out after ${this.timeoutMs}ms for task ${task.id}.`);
    }

    const result = parseClaudeStdout(res.stdout, task.id);
    if (result) return result;

    return failResult(
      task.id,
      `Claude CLI returned no parseable AgentResult (exit ${res.code}). ${diagnosticTail(res.stderr, res.stdout)}`,
    );
  }
}

/**
 * Parse the `claude -p --output-format json` envelope. Prefers a
 * `structured_output` object when present, otherwise extracts the JSON
 * AgentResult block from the `result` text. Falls back to scanning raw stdout
 * when the output is not a recognizable envelope.
 */
export function parseClaudeStdout(stdout: string, taskId: string): AgentResult | null {
  let text = stdout;
  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    if (envelope && typeof envelope === 'object') {
      if (envelope.structured_output !== undefined) {
        const structured = extractAgentResult(JSON.stringify(envelope.structured_output), taskId);
        if (structured) return structured;
      }
      if (typeof envelope.result === 'string') text = envelope.result;
    }
  } catch {
    // Not a JSON envelope (e.g. plain text or stream-json) — scan raw stdout.
  }
  return extractAgentResult(text, taskId);
}
