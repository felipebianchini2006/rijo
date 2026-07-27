import { RijoPaths } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import {
  openEngineSupervisorLedger,
  type DurableEngineSupervisorLedger,
} from '../durable/index.js';
import {
  buildHostEnv,
  CLAUDE_HOST_ENV_ALLOWLIST,
  CODEX_HOST_ENV_ALLOWLIST,
} from '../security/hostEnv.js';
import type { EngineSupervisorLedger } from '../supervisor/engineTypes.js';
import {
  engineSupervisorExitCode,
  runEngineSupervisor,
  type RunEngineSupervisorOptions,
} from './engine-supervisor.js';
import { resolveHostProvider } from './host.js';
import { runCli } from './main.js';

export interface ClosableEngineSupervisorLedger extends EngineSupervisorLedger {
  close(): Promise<void>;
}

export interface CliBootstrapDeps {
  runCli?: typeof runCli;
  openLedger?: (
    projectRoot: string,
    options: { mode: 'new' | 'run' },
  ) => Promise<ClosableEngineSupervisorLedger>;
  supervise?: (options: RunEngineSupervisorOptions) => ReturnType<typeof runEngineSupervisor>;
}

export function requiresEngineSupervisor(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['RIJO_ENGINE_CHILD'] === '1') return false;
  const command = argv[0];
  if (command === 'run') {
    // Explicit single-phase invocations are bounded maintenance operations:
    // they intentionally leave the run non-terminal and therefore must not be
    // restarted by the autonomous parent waiting for READY/NOT_READY/BLOCKED.
    const boundedTarget = argv
      .slice(1)
      .find((arg) => arg === 'next' || /^\d{2}$/.test(arg));
    return boundedTarget === undefined;
  }
  return command === 'new' && argv.some((arg) => arg === '--run' || arg.startsWith('--run='));
}

/**
 * Production binary boundary. Autonomous commands run as:
 *
 *   rijo-supervisor (this process) → rijo-engine (child) → workflow/hosts
 *
 * Read-only and non-autonomous commands stay in-process.
 */
export async function runCliEntrypoint(
  argv: string[],
  cwd = process.cwd(),
  sourceEnv: NodeJS.ProcessEnv = process.env,
  deps: CliBootstrapDeps = {},
): Promise<number> {
  const direct = deps.runCli ?? runCli;
  if (!requiresEngineSupervisor(argv, sourceEnv)) return direct(argv, {}, cwd);

  const command = argv[0] as 'new' | 'run';
  const config = loadConfig(new RijoPaths(cwd));
  const hostFlag = readHostFlag(argv.slice(1));
  const provider = resolveHostProvider(hostFlag, config);
  if (typeof provider === 'object') {
    console.error(`rijo: ${provider.error}`);
    return 2;
  }
  const hostAllowlist =
    provider === 'claude'
      ? CLAUDE_HOST_ENV_ALLOWLIST
      : provider === 'codex'
        ? CODEX_HOST_ENV_ALLOWLIST
        : [];
  const childEnv = {
    ...buildHostEnv(hostAllowlist, sourceEnv).env,
    RIJO_ENGINE_CHILD: '1',
  };

  const ledger = deps.openLedger
    ? await deps.openLedger(cwd, { mode: command })
    : await openEngineSupervisorLedger(cwd, { mode: command });
  try {
    const supervise = deps.supervise ?? runEngineSupervisor;
    const result = await supervise({
      projectRoot: cwd,
      args: argv,
      ledger,
      config: config.engine_supervisor,
      env: childEnv,
    });
    return engineSupervisorExitCode(result.status);
  } finally {
    await ledger.close();
  }
}

function readHostFlag(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--host') return args[index + 1];
    if (arg.startsWith('--host=')) return arg.slice('--host='.length);
  }
  return undefined;
}

// Structural assertion kept near the integration boundary: the durable
// implementation may not import the supervisor module, but must satisfy it.
void (undefined as unknown as DurableEngineSupervisorLedger satisfies EngineSupervisorLedger);
