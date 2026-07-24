import type { RijoConfig } from '../core/schemas/index.js';
import { ProcessController } from '../supervisor/processController.js';
import { buildClaudeLaunch, parseClaudeExit, type ClaudeLaunchOptions } from './claudeCli.js';
import { buildCodexLaunch, parseCodexExit, type CodexLaunchOptions } from './codexCli.js';

/**
 * Real, PID-owning host controllers.
 *
 * These wrap the SAME pure builders/parsers the in-process runners use
 * (buildClaudeLaunch/parseClaudeExit, buildCodexLaunch/parseCodexExit) but run
 * the CLI as an actual child process managed by ProcessController. That gives
 * the supervisor a genuine host pid: liveness is `kill(pid,0)`, cancellation is
 * a real signal to the whole process group, and hard termination is a real
 * SIGKILL/taskkill — never a blocking CLI hidden behind an in-process wrapper.
 *
 * A blocking CLI must NEVER be run through InProcessController: that would make
 * the supervisor believe an uninterruptible in-process call is the attempt, and
 * cancellation would silently fall through to fencing instead of killing a real
 * process. Use these controllers for CLI hosts.
 */

export interface ClaudeProcessControllerOptions extends ClaudeLaunchOptions {
  config: RijoConfig;
  /** Graceful-cancel signal (POSIX). Default SIGTERM. */
  cancelSignal?: NodeJS.Signals;
  /** Observability hook fired right after a child is spawned. */
  onSpawn?: (pid: number | null) => void;
  /** Host label recorded on the task record. Default 'claude'. */
  host?: string;
}

/** ProcessController that launches the Claude Code CLI per attempt. */
export class ClaudeProcessController extends ProcessController {
  constructor(opts: ClaudeProcessControllerOptions) {
    const { config, cancelSignal, onSpawn, host, ...launch } = opts;
    super(
      {
        buildCommand: (task) => buildClaudeLaunch(task, config, launch),
        parseResult: (task, exit) => parseClaudeExit(task, exit),
        cancelSignal,
        onSpawn: onSpawn ? (pid) => onSpawn(pid) : undefined,
      },
      host ?? 'claude',
    );
  }
}

export interface CodexProcessControllerOptions extends CodexLaunchOptions {
  config: RijoConfig;
  /** Graceful-cancel signal (POSIX). Default SIGTERM. */
  cancelSignal?: NodeJS.Signals;
  /** Observability hook fired right after a child is spawned. */
  onSpawn?: (pid: number | null) => void;
  /** Host label recorded on the task record. Default 'codex'. */
  host?: string;
}

/** ProcessController that launches the Codex CLI per attempt. */
export class CodexProcessController extends ProcessController {
  constructor(opts: CodexProcessControllerOptions) {
    const { config, cancelSignal, onSpawn, host, ...launch } = opts;
    super(
      {
        buildCommand: (task) => buildCodexLaunch(task, config, launch),
        parseResult: (task, exit) => parseCodexExit(task, exit),
        cancelSignal,
        onSpawn: onSpawn ? (pid) => onSpawn(pid) : undefined,
      },
      host ?? 'codex',
    );
  }
}
