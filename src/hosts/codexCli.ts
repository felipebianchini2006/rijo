import type { AgentRunner, RunnerCapabilities } from '../agents/runner.js';
import type { AgentTask, AgentResult } from '../agents/protocol.js';
import type { RijoConfig } from '../core/schemas/index.js';
import { resolveCodexTier } from '../agents/roles.js';
import { nodeSpawner, type Spawner } from './spawn.js';
import { validateCodexModel } from './models.js';
import { buildHostPrompt, extractAgentResult, diagnosticTail, failResult } from './parse.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: true, browser: false };

/** Codex sandbox modes (https://learn.chatgpt.com/docs/non-interactive-mode). */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexCliOptions {
  projectRoot: string;
  config: RijoConfig;
  spawner?: Spawner;
  timeoutMs?: number;
  capabilities?: Partial<RunnerCapabilities>;
  /** Binary name/path. Default 'codex'. */
  bin?: string;
  /**
   * Force a sandbox mode. By default it is derived per task: 'workspace-write'
   * when the task has an isolated workspace to write into, 'read-only'
   * otherwise (reviewers/researchers). Set this to override.
   */
  sandbox?: CodexSandbox;
}

/**
 * AgentRunner backed by the Codex CLI in non-interactive `codex exec` mode.
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
 * The concrete model is resolved from config (never the abstract tier) and
 * validated before spawning. The AgentResult is recovered from the agent's
 * final message in the JSONL stream; the reported `thread_id` is appended to
 * the summary when available. Unparseable output becomes an explicit ok:false.
 */
export class CodexCliRunner implements AgentRunner {
  public readonly capabilities: RunnerCapabilities;
  private readonly spawner: Spawner;
  private readonly timeoutMs: number;
  private readonly bin: string;
  private readonly forcedSandbox: CodexSandbox | undefined;
  private readonly projectRoot: string;
  private readonly config: RijoConfig;

  constructor(opts: CodexCliOptions) {
    this.projectRoot = opts.projectRoot;
    this.config = opts.config;
    this.spawner = opts.spawner ?? nodeSpawner;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bin = opts.bin ?? 'codex';
    this.forcedSandbox = opts.sandbox;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    let model: string;
    let effort: string;
    try {
      const tierName = task.tier ?? this.config.models[task.role];
      const tier = resolveCodexTier(this.config, tierName, task.role);
      validateCodexModel(tier.model);
      model = tier.model;
      effort = tier.reasoning_effort;
    } catch (err) {
      return failResult(task.id, err instanceof Error ? err.message : String(err));
    }

    const cwd = task.workspace?.root ?? this.projectRoot;
    const sandbox: CodexSandbox = this.forcedSandbox ?? (task.workspace ? 'workspace-write' : 'read-only');
    const args = [
      'exec',
      buildHostPrompt(task),
      '--json',
      '--sandbox',
      sandbox,
      '-m',
      model,
      '-c',
      `model_reasoning_effort="${effort}"`,
      '--skip-git-repo-check',
    ];

    const res = await this.spawner({ command: this.bin, args, cwd, timeoutMs: this.timeoutMs });

    if (res.spawnError) {
      return failResult(
        task.id,
        `Codex CLI could not be started (${res.spawnError}). Is "${this.bin}" installed and on PATH?`,
      );
    }
    if (res.timedOut) {
      return failResult(task.id, `Codex CLI timed out after ${this.timeoutMs}ms for task ${task.id}.`);
    }

    const { result, threadId, hostError } = parseCodexStdout(res.stdout, task.id);
    if (result) {
      if (threadId) result.summary = `${result.summary} (codex thread ${threadId})`;
      return result;
    }

    const tail = diagnosticTail(res.stderr, res.stdout);
    return failResult(
      task.id,
      hostError
        ? `Codex CLI returned no parseable AgentResult (exit ${res.code}). Host error: ${hostError}. ${tail}`
        : `Codex CLI returned no parseable AgentResult (exit ${res.code}). ${tail}`,
    );
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
