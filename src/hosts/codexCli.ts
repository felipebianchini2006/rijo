import type { AgentRunner, RunnerCapabilities } from '../agents/runner.js';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { RijoConfig } from '../core/schemas/index.js';
import { resolveCodexTier } from '../agents/roles.js';
import { nodeSpawner, type Spawner } from './spawn.js';
import { validateCodexModel } from './models.js';
import { buildHostPrompt, extractAgentResult, diagnosticTail, failResult } from './parse.js';
import { buildHostEnv, CODEX_HOST_ENV_ALLOWLIST } from '../security/hostEnv.js';
import type { ProcessLaunch, RawExit } from './processTypes.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: true, browser: false };

/** Codex sandbox modes (https://learn.chatgpt.com/docs/non-interactive-mode). */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexLaunchOptions {
  /** Binary name/path. Default 'codex'. */
  bin?: string;
  /**
   * Force a sandbox mode. By default it is derived per task: 'workspace-write'
   * when the task has an isolated workspace to write into, 'read-only'
   * otherwise (reviewers/researchers). Set this to override.
   */
  sandbox?: CodexSandbox;
  /** Project root — used only as the fallback cwd when a task has no workspace. */
  projectRoot?: string;
}

export interface CodexCliOptions extends CodexLaunchOptions {
  projectRoot: string;
  config: RijoConfig;
  spawner?: Spawner;
  timeoutMs?: number;
  capabilities?: Partial<RunnerCapabilities>;
}

/** Sandbox posture for a task: workspace-write only when there is a workspace to write into. */
export function sandboxForTask(task: AgentTask, forced?: CodexSandbox): CodexSandbox {
  return forced ?? (task.workspace ? 'workspace-write' : 'read-only');
}

/**
 * PURE command builder: turn a task + config into a concrete `codex exec`
 * launch. Single source of truth for Codex argv, shared by the runner and the
 * supervised CodexProcessController.
 *
 * Flags (verified 2026-07-24 against
 * https://learn.chatgpt.com/docs/non-interactive-mode and
 * https://learn.chatgpt.com/docs/models):
 *   codex exec <prompt>            non-interactive run
 *   --json                         JSONL event stream on stdout
 *   --sandbox <mode>               read-only | workspace-write | danger-full-access
 *   -m / --model <gpt-*>           concrete model from providers.codex[tier]
 *   -c model_reasoning_effort="…"  reasoning effort from the tier
 *   --skip-git-repo-check          allow running outside a git repo
 *
 * cwd is the attempt workspace root (never the canonical project root). Throws
 * on an unresolved/invalid model BEFORE any process is created.
 */
export function buildCodexLaunch(task: AgentTask, config: RijoConfig, opts: CodexLaunchOptions = {}): ProcessLaunch {
  const tierName = task.tier ?? config.models[task.role];
  const tier = resolveCodexTier(config, tierName, task.role);
  validateCodexModel(tier.model);

  const cwd = task.workspace?.root ?? opts.projectRoot ?? process.cwd();
  const sandbox = sandboxForTask(task, opts.sandbox);
  const args = [
    'exec',
    buildHostPrompt(task),
    '--json',
    '--sandbox',
    sandbox,
    '-m',
    tier.model,
    '-c',
    `model_reasoning_effort="${tier.reasoning_effort}"`,
    '--skip-git-repo-check',
  ];
  // Reconstructed environment: the CLI gets HOME (its credentials live in
  // ~/.codex) and its OWN auth variables, never the operator's whole shell.
  const { env, withheld } = buildHostEnv(CODEX_HOST_ENV_ALLOWLIST);
  return { command: opts.bin ?? 'codex', args, cwd, env, envWithheld: withheld };
}

/**
 * PURE exit parser: recover an AgentResult from a finished `codex exec`
 * process. On success the reported thread id is appended to the summary; on an
 * unparseable stream a host-error-aware ok:false diagnostic is produced. Never
 * simulates a result. (Spawn failures and timeouts are the caller's concern.)
 */
export function parseCodexExit(task: AgentTask, exit: RawExit): AgentResult {
  const { result, threadId, hostError } = parseCodexStdout(exit.stdout, task.id);
  if (result) {
    if (threadId) result.summary = `${result.summary} (codex thread ${threadId})`;
    return result;
  }
  const tail = diagnosticTail(exit.stderr, exit.stdout);
  return failResult(
    task.id,
    hostError
      ? `Codex CLI returned no parseable AgentResult (exit ${exit.code}). Host error: ${hostError}. ${tail}`
      : `Codex CLI returned no parseable AgentResult (exit ${exit.code}). ${tail}`,
  );
}

/**
 * AgentRunner backed by the Codex CLI in non-interactive `codex exec` mode. The
 * concrete model is resolved from config (never the abstract tier) and validated
 * before spawning; argv comes from `buildCodexLaunch` and results from
 * `parseCodexExit`, so this runner and the supervised CodexProcessController
 * share one command/parse implementation.
 */
export class CodexCliRunner implements AgentRunner {
  public readonly capabilities: RunnerCapabilities;
  private readonly spawner: Spawner;
  private readonly timeoutMs: number;
  private readonly config: RijoConfig;
  private readonly launchOpts: CodexLaunchOptions;

  constructor(opts: CodexCliOptions) {
    this.config = opts.config;
    this.spawner = opts.spawner ?? nodeSpawner;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    this.launchOpts = { bin: opts.bin, sandbox: opts.sandbox, projectRoot: opts.projectRoot };
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    let launch: ProcessLaunch;
    try {
      launch = buildCodexLaunch(task, this.config, this.launchOpts);
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
        `Codex CLI could not be started (${res.spawnError}). Is "${launch.command}" installed and on PATH?`,
      );
    }
    if (res.timedOut) {
      return failResult(task.id, `Codex CLI timed out after ${this.timeoutMs}ms for task ${task.id}.`);
    }

    return parseCodexExit(task, { code: res.code, signal: res.signal, stdout: res.stdout, stderr: res.stderr });
  }
}

/**
 * Local-config noise emitted by Codex as an `item.completed` item with
 * `type: 'error'` — not a real task failure, so it must never be picked as
 * the headline host error (but also must never crash the parse).
 */
const IGNORED_ERROR_NOISE = /ignoring malformed agent role definition/i;

/**
 * Pull a host-reported error message out of a single `codex exec --json`
 * event, covering the shapes actually observed on stream:
 *   {"type":"error","message":"…"}
 *   {"type":"turn.failed","error":{"message":"…"}}
 *   {"type":"item.completed","item":{"type":"error","message":"…"}}  (may be noise)
 * Returns null for events that don't carry an error message.
 */
function codexErrorMessage(ev: Record<string, unknown>): string | null {
  const type = String(ev.type ?? '');
  if (type === 'error' && typeof ev.message === 'string') return ev.message;
  if (type === 'turn.failed') {
    const err = ev.error as Record<string, unknown> | undefined;
    if (err && typeof err.message === 'string') return err.message;
  }
  if (type === 'item.completed') {
    const item = ev.item as Record<string, unknown> | undefined;
    if (item && String(item.type ?? '') === 'error' && typeof item.message === 'string') {
      return item.message;
    }
  }
  return null;
}

/** Pull the assistant's message text and the thread id from a `codex exec --json` event. */
function codexAgentText(ev: Record<string, unknown>): string | null {
  const item = (ev.item ?? ev) as Record<string, unknown>;
  if (!item || typeof item !== 'object') return null;
  const type = String(item.type ?? item.item_type ?? '');
  const isMsg = /agent_message|assistant_message|assistant/i.test(type) || item.role === 'assistant';
  if (!isMsg) return null;
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) {
    const joined = item.content
      .map((c) => (typeof c === 'string' ? c : ((c as Record<string, unknown>)?.text as string) ?? ''))
      .join('');
    if (joined) return joined;
  }
  return null;
}

/**
 * Parse the `codex exec --json` JSONL stream: collect assistant message texts
 * and the reported thread id, then recover an AgentResult from the last message
 * (falling back to the whole stdout). Robust to unknown event shapes — unknown
 * lines are skipped, never crash the parse.
 */
export function parseCodexStdout(
  stdout: string,
  taskId: string,
): { result: AgentResult | null; threadId: string | null; hostError: string | null } {
  const texts: string[] = [];
  let threadId: string | null = null;
  let hostError: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tid =
      (ev.thread_id as string | undefined) ?? ((ev.thread as Record<string, unknown>)?.id as string | undefined);
    if (typeof tid === 'string') threadId = tid;
    const text = codexAgentText(ev);
    if (text) texts.push(text);
    const errMsg = codexErrorMessage(ev);
    if (errMsg && !IGNORED_ERROR_NOISE.test(errMsg)) hostError = errMsg;
  }

  for (let i = texts.length - 1; i >= 0; i--) {
    const result = extractAgentResult(texts[i]!, taskId);
    if (result) return { result, threadId, hostError };
  }
  return { result: extractAgentResult(stdout, taskId), threadId, hostError };
}
