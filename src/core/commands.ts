import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { redact } from '../security/redact.js';

export type CommandCategory =
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'format'
  | 'package'
  | 'audit'
  | 'custom';

export interface CommandEvidence {
  command: string;
  exit_code: number;
  summary: string;
  duration_ms: number;
  /** true when the command policy refused to run it (never a repairable failure). */
  blocked: boolean;
  category: CommandCategory;
}

export interface ShellRunner {
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): CommandEvidence;
}

const SUMMARY_LIMIT = 2000;
const EXIT_BLOCKED = 126;

/**
 * Executables RIJO is willing to run for verification without explicit human
 * approval. Everything else is blocked. `git` is deliberately absent — Git is
 * driven through the typed GitOps layer, never through the free-form runner,
 * so an agent cannot smuggle `git push`/`git remote` through a test command.
 */
const ALLOWED_EXECUTABLES = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'bun', 'node', 'deno',
  'tsc', 'vitest', 'jest', 'mocha', 'ava', 'playwright',
  'eslint', 'prettier', 'biome',
  'python', 'python3', 'pytest', 'ruff', 'mypy',
  'go', 'cargo', 'make',
]);

/** Sub-commands that publish, authenticate or mutate global/remote state. */
const DENIED_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['publish', 'unpublish', 'login', 'adduser', 'token', 'access', 'owner', 'deprecate', 'dist-tag']),
  pnpm: new Set(['publish', 'login', 'add-user']),
  yarn: new Set(['publish', 'login']),
  bun: new Set(['publish', 'login']),
  npx: new Set([]),
  cargo: new Set(['publish', 'login', 'owner', 'yank']),
  go: new Set([]),
};

/** Shell metacharacters that would enable chaining, redirection or expansion. */
const METACHAR = /[|&;<>`$()\n\r*?~!\\]|\|\||&&|>>|<</;

export interface CommandDecision {
  ok: boolean;
  executable: string;
  args: string[];
  category: CommandCategory;
  reason?: string;
}

/** Split a command line into tokens, honouring simple double-quoted segments. */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) tokens.push(m[1] ?? m[2] ?? '');
  return tokens;
}

function categorize(exe: string, args: string[]): CommandCategory {
  const joined = `${exe} ${args.join(' ')}`;
  if (/\b(test|vitest|jest|mocha|pytest|ava)\b/.test(joined)) return 'test';
  if (/\btypecheck\b|\btsc\b|\bmypy\b/.test(joined)) return 'typecheck';
  if (/\blint\b|\beslint\b|\bruff\b|\bbiome\b/.test(joined)) return 'lint';
  if (/\bformat\b|\bprettier\b/.test(joined)) return 'format';
  if (/\bbuild\b|\bcompile\b/.test(joined)) return 'build';
  if (/\baudit\b/.test(joined)) return 'audit';
  if (/\bpack\b|\bpublish\b/.test(joined)) return 'package';
  return 'custom';
}

/**
 * Validate a raw command against the safe-execution policy WITHOUT running it.
 * Rejects shell metacharacters, non-allowlisted executables, path-based
 * executables (traversal), and denied sub-commands (publish/login/remote).
 */
export function evaluateCommand(raw: string): CommandDecision {
  const command = raw.trim();
  if (command === '') return { ok: false, executable: '', args: [], category: 'custom', reason: 'empty command' };
  if (METACHAR.test(command)) {
    return { ok: false, executable: '', args: [], category: 'custom', reason: 'shell metacharacters are not allowed (pipes, redirection, chaining, substitution, globs)' };
  }
  const tokens = tokenize(command);
  const executable = tokens[0] ?? '';
  const args = tokens.slice(1);
  // reject path-qualified executables (absolute or traversal) — allowlist is by bare name
  if (executable.includes('/') || executable.includes('\\') || path.isAbsolute(executable) || executable.includes('..')) {
    return { ok: false, executable, args, category: 'custom', reason: `executable must be a bare allowlisted name, got "${executable}"` };
  }
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    return { ok: false, executable, args, category: 'custom', reason: `executable "${executable}" is not in the safe allowlist` };
  }
  const denied = DENIED_SUBCOMMANDS[executable];
  if (denied) {
    const sub = args.find((a) => !a.startsWith('-'));
    if (sub && denied.has(sub)) {
      return { ok: false, executable, args, category: 'custom', reason: `sub-command "${executable} ${sub}" is denied (publish/auth/remote/global)` };
    }
  }
  return { ok: true, executable, args, category: categorize(executable, args) };
}

/**
 * Real command runner. Never uses a shell: the command is parsed, validated
 * against the policy, and executed as executable + args with shell:false.
 * Rejected commands return a blocked evidence record (exit 126) instead of
 * running — callers treat that as BLOCKED, not a repairable failure.
 */
export class SystemShellRunner implements ShellRunner {
  run(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): CommandEvidence {
    const decision = evaluateCommand(command);
    if (!decision.ok) {
      return { command, exit_code: EXIT_BLOCKED, summary: `blocked by command policy: ${decision.reason}`, duration_ms: 0, blocked: true, category: decision.category };
    }
    const started = Date.now();
    const result = spawnSync(decision.executable, decision.args, {
      shell: false,
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 10 * 60 * 1000,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_yes: 'true' },
    });
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const tail = out.length > SUMMARY_LIMIT ? `…${out.slice(-SUMMARY_LIMIT)}` : out;
    return {
      command,
      exit_code: result.status ?? (result.error ? 1 : 0),
      summary: redact(tail),
      duration_ms: Date.now() - started,
      blocked: false,
      category: decision.category,
    };
  }
}

/** Test double: scripted responses per command pattern; still runs policy validation. */
export class FakeShellRunner implements ShellRunner {
  public readonly calls: string[] = [];
  constructor(
    private readonly script: Array<{ match: RegExp; exitCode: number; output?: string }> = [],
    private readonly defaultExit = 0,
    /** when true, still enforce the command policy so tests can assert blocking */
    private readonly enforcePolicy = false,
  ) {}

  run(command: string): CommandEvidence {
    this.calls.push(command);
    if (this.enforcePolicy) {
      const decision = evaluateCommand(command);
      if (!decision.ok) {
        return { command, exit_code: EXIT_BLOCKED, summary: `blocked by command policy: ${decision.reason}`, duration_ms: 0, blocked: true, category: decision.category };
      }
    }
    const hit = this.script.find((s) => s.match.test(command));
    const decision = evaluateCommand(command);
    return {
      command,
      exit_code: hit?.exitCode ?? this.defaultExit,
      summary: redact(hit?.output ?? ''),
      duration_ms: 1,
      blocked: false,
      category: decision.ok ? decision.category : 'custom',
    };
  }
}
