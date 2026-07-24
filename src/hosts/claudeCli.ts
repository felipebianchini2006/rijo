import type { AgentRunner, RunnerCapabilities } from '../agents/runner.js';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { RijoConfig, ModelRole } from '../core/schemas/index.js';
import { resolveClaudeTier } from '../agents/roles.js';
import { nodeSpawner, type Spawner } from './spawn.js';
import { validateClaudeModel } from './models.js';
import { buildHostPrompt, extractAgentResult, diagnosticTail, failResult } from './parse.js';
import type { ProcessLaunch, RawExit } from './processTypes.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: true, browser: false };

/**
 * Roles allowed to write. Everyone else (planner/researcher/reviewer/lead/qa)
 * runs read-only: `--permission-mode plan` in an isolated snapshot. Only the
 * worker mutates files, and only inside its attempt workspace.
 */
const WRITER_ROLES: ReadonlySet<ModelRole> = new Set<ModelRole>(['worker']);

/**
 * Sensitive path patterns the Claude host must NEVER read or write, regardless
 * of role or permission mode. Expressed as deny rules in a settings JSON blob
 * passed via `--settings` (deny rules take precedence over every allow). Both
 * project-relative and home-directory locations are covered so a workspace copy
 * cannot exfiltrate real credentials.
 */
const SENSITIVE_GLOBS: readonly string[] = [
  // dotenv files, at the root and nested
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  // private keys / certs
  '**/*.pem',
  '**/id_rsa*',
  // credential stores in the home directory
  '~/.ssh/**',
  '~/.aws/**',
  '~/.config/gh/**',
  '~/.gnupg/**',
  // package / network auth files
  '.npmrc',
  '**/.npmrc',
  '~/.npmrc',
  '.netrc',
  '**/.netrc',
  '~/.netrc',
];

/** File-access tools whose reads/writes the deny rules gate. */
const GUARDED_TOOLS = ['Read', 'Edit', 'Write'] as const;

/** Expand the sensitive globs into concrete `Tool(glob)` deny rules. */
export function sensitiveDenyRules(extra: readonly string[] = []): string[] {
  const rules: string[] = [];
  for (const glob of SENSITIVE_GLOBS) {
    for (const tool of GUARDED_TOOLS) rules.push(`${tool}(${glob})`);
  }
  return [...rules, ...extra];
}

/** The `--settings` JSON payload that enforces the sensitive-path denylist. */
export function claudeDenySettings(extra: readonly string[] = []): string {
  return JSON.stringify({ permissions: { deny: sensitiveDenyRules(extra) } });
}

/** Permission posture for a task: workers accept edits (workspace only), everyone else is read-only. */
export function permissionModeForRole(role: ModelRole): string {
  return WRITER_ROLES.has(role) ? 'acceptEdits' : 'plan';
}

export interface ClaudeLaunchOptions {
  /** Binary name/path. Default 'claude'. */
  bin?: string;
  /**
   * Explicit permission-mode override. When omitted it is DERIVED from the task
   * role: 'acceptEdits' for writers (workspace-scoped), 'plan' (read-only) for
   * planner/researcher/reviewer/lead/qa.
   */
  permissionMode?: string;
  /** Extra tools to auto-approve, e.g. ['Bash','Read','Edit']. */
  allowedTools?: string[];
  /** Additional deny rules appended to the built-in sensitive-path denylist. */
  extraDenyRules?: string[];
  /** Project root — used only as the fallback cwd when a task has no workspace. */
  projectRoot?: string;
}

export interface ClaudeCliOptions extends ClaudeLaunchOptions {
  /** Project root; also the fallback cwd when a task has no isolated workspace. */
  projectRoot: string;
  config: RijoConfig;
  /** Injectable process spawner (real by default; faked in tests). */
  spawner?: Spawner;
  timeoutMs?: number;
  /** Override reported capabilities. `browser` stays false unless truly wired. */
  capabilities?: Partial<RunnerCapabilities>;
}

/**
 * PURE command builder: turn a task + config into a concrete `claude -p` launch.
 * This is the single source of truth for Claude argv — the runner and the
 * ProcessController both go through it, so args can never drift between the
 * unsupervised and supervised paths.
 *
 * Flags (verified 2026-07-24 against https://code.claude.com/docs/en/headless
 * and https://code.claude.com/docs/en/cli-reference; permission modes and
 * --settings/--disallowedTools confirmed against claude 2.1.x --help):
 *   -p / --print              non-interactive
 *   --output-format json      structured envelope with a `result` text field
 *   --model <alias|claude-*>  concrete model from providers.claude[tier]
 *   --effort <low|medium|high>  reasoning effort from the tier
 *   --permission-mode <mode>  'acceptEdits' (workers) or 'plan' (read-only roles)
 *   --settings <json>         deny rules blocking sensitive files (.env, keys, …)
 *   --allowedTools <list>     auto-approved tools (optional)
 *
 * Write-fence guarantees (P0.4):
 *   - cwd is the ATTEMPT WORKSPACE root (never the canonical project root);
 *   - the canonical project root is NEVER granted as an extra writable dir —
 *     there is no --add-dir here, so a workspace attempt cannot escape into the
 *     controlled checkout;
 *   - read-only roles run under `--permission-mode plan`;
 *   - a denylist blocks reading/writing credentials even inside the workspace.
 *
 * Throws on an unresolved/invalid model BEFORE any process is created, so a bad
 * model fails loud instead of after a spawn.
 */
export function buildClaudeLaunch(task: AgentTask, config: RijoConfig, opts: ClaudeLaunchOptions = {}): ProcessLaunch {
  const tierName = task.tier ?? config.models[task.role];
  const tier = resolveClaudeTier(config, tierName, task.role);
  validateClaudeModel(tier.model);

  const cwd = task.workspace?.root ?? opts.projectRoot ?? process.cwd();
  const permissionMode = opts.permissionMode ?? permissionModeForRole(task.role);

  const args = [
    '-p',
    buildHostPrompt(task),
    '--output-format',
    'json',
    '--model',
    tier.model,
    '--effort',
    tier.effort,
    '--permission-mode',
    permissionMode,
    // Deny rules block reads/writes of credentials even under acceptEdits.
    '--settings',
    claudeDenySettings(opts.extraDenyRules),
  ];
  if (opts.allowedTools && opts.allowedTools.length) args.push('--allowedTools', opts.allowedTools.join(','));

  return { command: opts.bin ?? 'claude', args, cwd };
}

/**
 * PURE exit parser: recover an AgentResult from a finished `claude -p` process.
 * Success → the parsed AgentResult; unparseable → an explicit ok:false with a
 * diagnostic tail. Never simulates a result. (Spawn failures and timeouts are
 * handled by the caller, which owns those facts; this parser only interprets a
 * process that actually ran.)
 */
export function parseClaudeExit(task: AgentTask, exit: RawExit): AgentResult {
  const result = parseClaudeStdout(exit.stdout, task.id);
  if (result) return result;
  return failResult(
    task.id,
    `Claude CLI returned no parseable AgentResult (exit ${exit.code}). ${diagnosticTail(exit.stderr, exit.stdout)}`,
  );
}

/**
 * AgentRunner backed by the Claude Code CLI in headless/print mode. The concrete
 * model is resolved from config (never the abstract tier) and validated before
 * spawning; argv comes from `buildClaudeLaunch` and results from
 * `parseClaudeExit`, so this runner and the supervised ClaudeProcessController
 * share one command/parse implementation.
 */
export class ClaudeCliRunner implements AgentRunner {
  public readonly capabilities: RunnerCapabilities;
  private readonly spawner: Spawner;
  private readonly timeoutMs: number;
  private readonly projectRoot: string;
  private readonly config: RijoConfig;
  private readonly launchOpts: ClaudeLaunchOptions;

  constructor(opts: ClaudeCliOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.spawner = opts.spawner ?? nodeSpawner;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    this.launchOpts = {
      bin: opts.bin,
      permissionMode: opts.permissionMode,
      allowedTools: opts.allowedTools,
      extraDenyRules: opts.extraDenyRules,
      projectRoot: opts.projectRoot,
    };
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    let launch: ProcessLaunch;
    try {
      launch = buildClaudeLaunch(task, this.config, this.launchOpts);
    } catch (err) {
      return failResult(task.id, err instanceof Error ? err.message : String(err));
    }

    const res = await this.spawner({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      input: launch.input,
      env: launch.env,
      timeoutMs: this.timeoutMs,
    });

    if (res.spawnError) {
      return failResult(
        task.id,
        `Claude CLI could not be started (${res.spawnError}). Is "${launch.command}" installed and on PATH?`,
      );
    }
    if (res.timedOut) {
      return failResult(task.id, `Claude CLI timed out after ${this.timeoutMs}ms for task ${task.id}.`);
    }

    return parseClaudeExit(task, { code: res.code, signal: res.signal, stdout: res.stdout, stderr: res.stderr });
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
