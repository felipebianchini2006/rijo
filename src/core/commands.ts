import { spawnSync } from 'node:child_process';
import { redact } from '../security/redact.js';

export interface CommandEvidence {
  command: string;
  exit_code: number;
  summary: string;
  duration_ms: number;
}

export interface ShellRunner {
  run(command: string, opts?: { cwd?: string; timeoutMs?: number }): CommandEvidence;
}

const SUMMARY_LIMIT = 2000;

/** Real shell runner. Captures command, exit code and a redacted output summary. */
export class SystemShellRunner implements ShellRunner {
  run(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): CommandEvidence {
    const started = Date.now();
    const result = spawnSync(command, {
      shell: true,
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 10 * 60 * 1000,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const tail = out.length > SUMMARY_LIMIT ? `…${out.slice(-SUMMARY_LIMIT)}` : out;
    return {
      command,
      exit_code: result.status ?? (result.error ? 1 : 0),
      summary: redact(tail),
      duration_ms: Date.now() - started,
    };
  }
}

/** Test double: scripted responses per command pattern. */
export class FakeShellRunner implements ShellRunner {
  public readonly calls: string[] = [];
  constructor(
    private readonly script: Array<{ match: RegExp; exitCode: number; output?: string }> = [],
    private readonly defaultExit = 0,
  ) {}

  run(command: string): CommandEvidence {
    this.calls.push(command);
    const hit = this.script.find((s) => s.match.test(command));
    return {
      command,
      exit_code: hit?.exitCode ?? this.defaultExit,
      summary: redact(hit?.output ?? ''),
      duration_ms: 1,
    };
  }
}
