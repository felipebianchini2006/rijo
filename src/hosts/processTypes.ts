/**
 * Shared value types for launching a host CLI as a real child process and for
 * the raw exit facts that come back. These are the single vocabulary shared by
 * the pure command builders/parsers (src/hosts/*Cli.ts) and the generic
 * ProcessController (src/supervisor/processController.ts) so there is exactly
 * one description of "how to launch" and "what came back" — no drift between
 * the runner path and the supervised-process path.
 */

/** A single external-process invocation. argv is structured, never a shell string. */
export interface ProcessLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** The raw, factual result of a finished child process (no interpretation). */
export interface RawExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
