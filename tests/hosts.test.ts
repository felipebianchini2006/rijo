import { describe, it, expect } from 'vitest';
import { ClaudeCliRunner, buildClaudeLaunch, parseClaudeExit } from '../src/hosts/claudeCli.js';
import { CodexCliRunner, buildCodexLaunch, parseCodexExit } from '../src/hosts/codexCli.js';
import { detectClaudeCli, detectCodexCli } from '../src/hosts/detect.js';
import { validateClaudeModel, validateCodexModel, InvalidModelError } from '../src/hosts/models.js';
import { extractAgentResult, buildHostPrompt } from '../src/hosts/parse.js';
import type { Spawner, SpawnRequest, SpawnResult } from '../src/hosts/spawn.js';
import type { RawExit } from '../src/hosts/processTypes.js';
import { ConfigSchema, type RijoConfig } from '../src/core/schemas/index.js';
import type { AgentTask, AgentResult } from '../src/agents/protocol.js';

const CONFIG: RijoConfig = ConfigSchema.parse({});

/** Records the last argv/cwd it was called with, and returns a scripted result. */
function recordingSpawner(
  respond: (req: SpawnRequest) => Partial<SpawnResult>,
): { spawner: Spawner; calls: SpawnRequest[] } {
  const calls: SpawnRequest[] = [];
  const spawner: Spawner = async (req) => {
    calls.push(req);
    return {
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...respond(req),
    };
  };
  return { spawner, calls };
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'exec-01-T01',
    role: 'worker',
    tier: 'economical-coding',
    objective: 'Implement the widget module.',
    canonical_files: ['.rijo/STATE.md'],
    code_files: ['src/widget.ts'],
    write_scope: ['src/widget.ts'],
    acceptance_criteria: ['it builds'],
    verification_commands: ['npm run build'],
    return_format: 'JSON payload {done:boolean}',
    notes: '',
    workspace: { id: 'ws-1', root: '/tmp/rijo-ws-1' },
    canonical_baseline: null,
    ...overrides,
  };
}

function agentResultJson(extra: Partial<AgentResult> = {}): string {
  const result: AgentResult = {
    task_id: 'exec-01-T01',
    ok: true,
    summary: 'implemented widget',
    files_written: ['src/widget.ts'],
    payload: { done: true },
    scope_requests: [],
    ...extra,
  };
  return '```json\n' + JSON.stringify(result) + '\n```';
}

describe('model validation', () => {
  it('accepts Claude aliases and claude-* ids, rejects tier placeholders', () => {
    for (const m of ['opus', 'sonnet', 'haiku', 'fable', 'claude-sonnet-5', 'us.anthropic.claude-x']) {
      expect(() => validateClaudeModel(m)).not.toThrow();
    }
    for (const bad of ['economical-coding', 'strongest', 'balanced-reasoning', 'gpt-5.6-sol', '']) {
      expect(() => validateClaudeModel(bad)).toThrow(InvalidModelError);
    }
  });

  it('accepts Codex gpt-*/o*/codex-* ids, rejects tier placeholders and claude aliases', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'o3', 'o4-mini', 'codex-mini-latest']) {
      expect(() => validateCodexModel(m)).not.toThrow();
    }
    for (const bad of ['economical-research', 'strongest', 'sonnet', 'opus', '']) {
      expect(() => validateCodexModel(bad)).toThrow(InvalidModelError);
    }
  });
});

describe('extractAgentResult', () => {
  it('recovers a fenced JSON AgentResult and coerces a missing task_id', () => {
    const text = 'Some reasoning...\n```json\n{"ok":true,"summary":"done","files_written":[],"payload":null,"scope_requests":[]}\n```';
    const r = extractAgentResult(text, 'exec-01-T01');
    expect(r).not.toBeNull();
    expect(r!.task_id).toBe('exec-01-T01');
    expect(r!.ok).toBe(true);
  });

  it('prefers the last valid block and ignores non-matching JSON', () => {
    const text = '{"unrelated":1}\n```json\n{"task_id":"x","ok":false,"summary":"first"}\n```\n```json\n{"task_id":"exec-01-T01","ok":true,"summary":"final"}\n```';
    const r = extractAgentResult(text, 'exec-01-T01');
    expect(r!.summary).toBe('final');
    expect(r!.ok).toBe(true);
  });

  it('returns null when no AgentResult is present', () => {
    expect(extractAgentResult('no json here', 't')).toBeNull();
    expect(extractAgentResult('{"foo":"bar"}', 't')).toBeNull();
  });
});

describe('buildHostPrompt', () => {
  it('embeds the brief and demands a trailing JSON AgentResult block', () => {
    const p = buildHostPrompt(task());
    expect(p).toContain('Implement the widget module.');
    expect(p).toContain('Host response contract');
    expect(p).toContain('```json');
    expect(p).toContain('src/widget.ts');
  });
});

describe('ClaudeCliRunner argv assembly', () => {
  it('spawns with the concrete model, effort, permission mode and workspace cwd', async () => {
    const { spawner, calls } = recordingSpawner(() => ({
      stdout: JSON.stringify({ result: agentResultJson() }),
    }));
    const runner = new ClaudeCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    const result = await runner.runTask(task());

    expect(result.ok).toBe(true);
    expect(result.files_written).toEqual(['src/widget.ts']);
    expect(runner.capabilities.browser).toBe(false);

    const { command, args, cwd } = calls[0]!;
    expect(command).toBe('claude');
    expect(cwd).toBe('/tmp/rijo-ws-1');
    // worker -> economical-coding -> sonnet / medium (default config)
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    // worker -> writer role -> acceptEdits (workspace-scoped)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    // WRITE FENCE (P0.4): the canonical project root is NEVER granted as a
    // writable/readable extra dir — no --add-dir leak into the checkout.
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('/proj');
    // deny rules for sensitive files are always passed via --settings
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Read(.env)', 'Read(**/*.pem)']));
  });

  it('parses structured_output when the envelope carries it', async () => {
    const structured: AgentResult = {
      task_id: 'exec-01-T01',
      ok: true,
      summary: 'via structured_output',
      files_written: [],
      payload: null,
      scope_requests: [],
    };
    const { spawner } = recordingSpawner(() => ({
      stdout: JSON.stringify({ result: 'ignored text', structured_output: structured }),
    }));
    const runner = new ClaudeCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    const r = await runner.runTask(task());
    expect(r.summary).toBe('via structured_output');
  });

  it('rejects an invalid configured model BEFORE spawning', async () => {
    const badConfig = ConfigSchema.parse({
      providers: { claude: { 'economical-coding': { model: 'strongest', effort: 'medium' } } },
    });
    const { spawner, calls } = recordingSpawner(() => ({ stdout: '' }));
    const runner = new ClaudeCliRunner({ projectRoot: '/proj', config: badConfig, spawner });
    const r = await runner.runTask(task());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Invalid claude model');
    expect(calls.length).toBe(0); // never spawned
  });

  it('reports a spawn failure as an explicit ok:false (never simulated)', async () => {
    const spawner: Spawner = async () => ({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: 'ENOENT',
    });
    const runner = new ClaudeCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    const r = await runner.runTask(task());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('ENOENT');
  });

  it('reports a timeout as an explicit ok:false', async () => {
    const spawner: Spawner = async () => ({
      code: null,
      signal: 'SIGKILL',
      stdout: '',
      stderr: '',
      timedOut: true,
    });
    const runner = new ClaudeCliRunner({ projectRoot: '/proj', config: CONFIG, spawner, timeoutMs: 5 });
    const r = await runner.runTask(task());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('timed out');
  });

  it('returns ok:false with a diagnostic when output is unparseable', async () => {
    const { spawner } = recordingSpawner(() => ({ stdout: 'garbage, no json', stderr: 'boom', code: 1 }));
    const runner = new ClaudeCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    const r = await runner.runTask(task());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('no parseable AgentResult');
    expect(r.summary).toContain('boom');
  });
});

describe('CodexCliRunner argv assembly', () => {
  it('spawns codex exec with sandbox, model, reasoning effort and JSONL parsing', async () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th_abc123' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: agentResultJson() } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }),
    ].join('\n');
    const { spawner, calls } = recordingSpawner(() => ({ stdout }));
    const runner = new CodexCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    const r = await runner.runTask(task());

    expect(r.ok).toBe(true);
    // thread id recorded in the summary
    expect(r.summary).toContain('codex thread th_abc123');

    const { command, args, cwd } = calls[0]!;
    expect(command).toBe('codex');
    expect(args[0]).toBe('exec');
    expect(cwd).toBe('/tmp/rijo-ws-1');
    expect(args).toContain('--json');
    // worker has a workspace -> workspace-write sandbox
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    // worker -> economical-coding -> gpt-5.6-terra / medium (corrected defaults)
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-terra');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="medium"');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('uses a read-only sandbox for tasks without a workspace (reviewer/researcher)', async () => {
    const stdout = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: agentResultJson({ files_written: [] }) },
    });
    const { spawner, calls } = recordingSpawner(() => ({ stdout }));
    const runner = new CodexCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    await runner.runTask(task({ role: 'researcher', tier: 'economical-research', workspace: null }));
    const { args } = calls[0]!;
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    // researcher -> economical-research -> gpt-5.6-luna / low
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-luna');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort="low"');
  });

  it('rejects an invalid configured Codex model before spawning', async () => {
    const badConfig = ConfigSchema.parse({
      providers: { codex: { 'economical-coding': { model: 'sonnet', reasoning_effort: 'medium' } } },
    });
    const { spawner, calls } = recordingSpawner(() => ({ stdout: '' }));
    const runner = new CodexCliRunner({ projectRoot: '/proj', config: badConfig, spawner });
    const r = await runner.runTask(task());
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Invalid codex model');
    expect(calls.length).toBe(0);
  });

  it('surfaces the host error (usage limit) in the ok:false summary when no AgentResult is parseable', async () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th_abc123' }),
      JSON.stringify({
        type: 'error',
        message:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage ... try again at Jul 28th, 2026 2:04 PM.",
      }),
      JSON.stringify({
        type: 'turn.failed',
        error: {
          message:
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage ... try again at Jul 28th, 2026 2:04 PM.",
        },
      }),
    ].join('\n');
    const { spawner } = recordingSpawner(() => ({
      stdout,
      stderr: 'Reading additional input from stdin...',
      code: 1,
    }));
    const runner = new CodexCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    const r = await runner.runTask(task());

    expect(r.ok).toBe(false);
    expect(r.summary).toContain('usage limit');
    expect(r.summary).toContain('Host error');
    expect(r.summary).toContain('no parseable AgentResult');
  });

  it('ignores "Ignoring malformed agent role definition" noise and falls back to the normal tail', async () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th_abc123' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'error', message: 'Ignoring malformed agent role definition at ~/.codex/roles/foo.yaml' },
      }),
    ].join('\n');
    const { spawner } = recordingSpawner(() => ({
      stdout,
      stderr: 'Reading additional input from stdin...',
      code: 1,
    }));
    const runner = new CodexCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    const r = await runner.runTask(task());

    expect(r.ok).toBe(false);
    expect(r.summary).not.toContain('Host error');
    expect(r.summary).toContain('Reading additional input from stdin');
  });

  it('fails clearly when the requested tier has no provider mapping', async () => {
    const { spawner, calls } = recordingSpawner(() => ({ stdout: '' }));
    const runner = new CodexCliRunner({ projectRoot: '/proj', config: CONFIG, spawner });
    // 'nonexistent-tier' is not in providers.codex and role fallback (worker ->
    // economical-coding) IS present, so this actually resolves; use a config
    // whose role tier is also absent to force the error.
    const emptyProviders = ConfigSchema.parse({ providers: { codex: {} } });
    const runner2 = new CodexCliRunner({ projectRoot: '/proj', config: emptyProviders, spawner });
    const r = await runner2.runTask(task({ tier: 'nonexistent-tier' }));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('No codex provider mapping');
    expect(calls.length).toBe(0);
    void runner;
  });
});

/** Value that follows a flag in an argv array. */
function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildClaudeLaunch (pure builder, P0.2/P0.4)', () => {
  it('builds worker argv: concrete model/effort, acceptEdits, workspace cwd, deny settings, NO project-root leak', () => {
    const launch = buildClaudeLaunch(task(), CONFIG, { projectRoot: '/proj' });
    expect(launch.command).toBe('claude');
    expect(launch.cwd).toBe('/tmp/rijo-ws-1'); // workspace root, never /proj
    expect(argAfter(launch.args, '--model')).toBe('sonnet');
    expect(argAfter(launch.args, '--effort')).toBe('medium');
    expect(argAfter(launch.args, '--permission-mode')).toBe('acceptEdits');
    expect(launch.args).not.toContain('--add-dir');
    expect(launch.args).not.toContain('/proj');
    const deny = JSON.parse(argAfter(launch.args, '--settings')!).permissions.deny as string[];
    // credentials blocked for read AND write, project-relative and in $HOME
    expect(deny).toEqual(
      expect.arrayContaining([
        'Read(.env)',
        'Write(.env)',
        'Edit(.env)',
        'Read(**/*.pem)',
        'Read(**/id_rsa*)',
        'Read(~/.ssh/**)',
        'Read(~/.aws/**)',
        'Read(~/.config/gh/**)',
        'Read(~/.gnupg/**)',
        'Read(.npmrc)',
        'Read(.netrc)',
      ]),
    );
  });

  it('read-only roles (planner/researcher/reviewer) run under --permission-mode plan', () => {
    for (const role of ['planner', 'researcher', 'reviewer'] as const) {
      const launch = buildClaudeLaunch(task({ role, tier: 'balanced-reasoning', workspace: null }), CONFIG, {
        projectRoot: '/proj',
      });
      expect(argAfter(launch.args, '--permission-mode'), role).toBe('plan');
      // read-only role still carries the sensitive-file denylist
      expect(launch.args).toContain('--settings');
    }
  });

  it('resolves researcher tier to the concrete economical-research model', () => {
    const launch = buildClaudeLaunch(task({ role: 'researcher', tier: 'economical-research', workspace: null }), CONFIG);
    expect(argAfter(launch.args, '--model')).toBe('haiku');
  });

  it('honours an explicit permission-mode override', () => {
    const launch = buildClaudeLaunch(task(), CONFIG, { permissionMode: 'bypassPermissions', projectRoot: '/proj' });
    expect(argAfter(launch.args, '--permission-mode')).toBe('bypassPermissions');
  });

  it('throws on an invalid configured model BEFORE producing a launch', () => {
    const badConfig = ConfigSchema.parse({
      providers: { claude: { 'economical-coding': { model: 'strongest', effort: 'medium' } } },
    });
    expect(() => buildClaudeLaunch(task(), badConfig, { projectRoot: '/proj' })).toThrow(/Invalid claude model/);
  });
});

describe('buildCodexLaunch (pure builder, P0.2)', () => {
  it('builds worker argv: workspace-write sandbox, concrete model/effort, workspace cwd', () => {
    const launch = buildCodexLaunch(task(), CONFIG, { projectRoot: '/proj' });
    expect(launch.command).toBe('codex');
    expect(launch.args[0]).toBe('exec');
    expect(launch.cwd).toBe('/tmp/rijo-ws-1');
    expect(argAfter(launch.args, '--sandbox')).toBe('workspace-write');
    expect(argAfter(launch.args, '-m')).toBe('gpt-5.6-terra');
    expect(argAfter(launch.args, '-c')).toBe('model_reasoning_effort="medium"');
    expect(launch.args).toContain('--skip-git-repo-check');
  });

  it('uses read-only sandbox and the fast model for a researcher without a workspace', () => {
    const launch = buildCodexLaunch(task({ role: 'researcher', tier: 'economical-research', workspace: null }), CONFIG);
    expect(argAfter(launch.args, '--sandbox')).toBe('read-only');
    expect(argAfter(launch.args, '-m')).toBe('gpt-5.6-luna');
    expect(argAfter(launch.args, '-c')).toBe('model_reasoning_effort="low"');
  });

  it('throws on an invalid configured Codex model', () => {
    const badConfig = ConfigSchema.parse({
      providers: { codex: { 'economical-coding': { model: 'sonnet', reasoning_effort: 'medium' } } },
    });
    expect(() => buildCodexLaunch(task(), badConfig, { projectRoot: '/proj' })).toThrow(/Invalid codex model/);
  });
});

describe('parseClaudeExit / parseCodexExit (pure parsers, P0.2)', () => {
  const exit = (over: Partial<RawExit>): RawExit => ({ code: 0, signal: null, stdout: '', stderr: '', ...over });

  it('parseClaudeExit recovers an AgentResult from the JSON envelope', () => {
    const r = parseClaudeExit(task(), exit({ stdout: JSON.stringify({ result: agentResultJson() }) }));
    expect(r.ok).toBe(true);
    expect(r.files_written).toEqual(['src/widget.ts']);
  });

  it('parseClaudeExit returns ok:false with a diagnostic when unparseable', () => {
    const r = parseClaudeExit(task(), exit({ code: 1, stdout: 'garbage', stderr: 'boom' }));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('no parseable AgentResult');
    expect(r.summary).toContain('boom');
  });

  it('parseCodexExit recovers the result and appends the thread id', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th_xyz' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: agentResultJson() } }),
    ].join('\n');
    const r = parseCodexExit(task(), exit({ stdout }));
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('codex thread th_xyz');
  });

  it('parseCodexExit surfaces a usage-limit host error when nothing parses', () => {
    const stdout = [
      JSON.stringify({ type: 'error', message: "You've hit your usage limit. try again later." }),
      JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit." } }),
    ].join('\n');
    const r = parseCodexExit(task(), exit({ code: 1, stdout, stderr: 'reading stdin' }));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('usage limit');
    expect(r.summary).toContain('Host error');
  });

  it('parseCodexExit skips malformed JSONL lines without crashing', () => {
    const stdout = [
      'not json at all',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: agentResultJson() } }),
      '{ half',
    ].join('\n');
    const r = parseCodexExit(task(), exit({ stdout }));
    expect(r.ok).toBe(true);
  });
});

describe('detection', () => {
  it('reports available + version when --version exits 0', async () => {
    const spawner: Spawner = async (req) => ({
      code: 0,
      signal: null,
      stdout: req.command === 'claude' ? '2.1.214 (Claude Code)' : 'codex-cli 0.9.0',
      stderr: '',
      timedOut: false,
    });
    expect(await detectClaudeCli('/x', 'claude', spawner)).toEqual({
      available: true,
      version: '2.1.214 (Claude Code)',
    });
    expect(await detectCodexCli('/x', 'codex', spawner)).toEqual({ available: true, version: 'codex-cli 0.9.0' });
  });

  it('reports unavailable when the binary is missing (never faked)', async () => {
    const spawner: Spawner = async () => ({
      code: null,
      signal: null,
      stdout: '',
      stderr: 'not found',
      timedOut: false,
      spawnError: 'ENOENT',
    });
    expect(await detectClaudeCli('/x', 'claude', spawner)).toEqual({ available: false, version: null });
    expect(await detectCodexCli('/x', 'codex', spawner)).toEqual({ available: false, version: null });
  });
});
