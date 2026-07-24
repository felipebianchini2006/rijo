import { RijoPaths } from '../core/paths.js';
import type { RijoConfig } from '../core/schemas/index.js';
import type { RunnerCapabilities } from '../agents/runner.js';
import { SupervisedExecutor, type TaskExecutor } from '../workflows/executor.js';
import { ClaudeProcessController, CodexProcessController } from '../hosts/processControllers.js';
import { detectClaudeCli, detectCodexCli, type HostAvailability } from '../hosts/detect.js';
import { nodeSpawner, type Spawner } from '../hosts/spawn.js';
import type { Clock } from '../supervisor/clock.js';

/** Provider the operator (or config) selected. `none` means host-agnostic. */
export type HostProvider = 'claude' | 'codex' | 'none';

/**
 * Capabilities a CLI host controller genuinely offers: subagents and
 * parallelism yes, in-process browser no (the QA/UI-smoke gate degrades to
 * "skipped" rather than simulating a browser). Mirrors the CLI runners'
 * DEFAULT_CAPABILITIES so the supervised and unsupervised paths agree.
 */
export const HOST_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: true, browser: false };

export interface HostExecutorOptions {
  /** Concrete host to drive (never 'none' — resolve that away before calling). */
  provider: 'claude' | 'codex';
  projectRoot: string;
  config: RijoConfig;
  paths: RijoPaths;
  /** Detection spawner seam (the real one by default; faked in tests). */
  spawner?: Spawner;
  /** Injectable clock for deterministic supervision timing in tests. */
  clock?: Clock;
  /** Legible progress/heartbeat lines (host availability, per-attempt spawn). Defaults to stderr. */
  onProgress?: (line: string) => void;
}

export type HostBootstrap =
  | { ok: true; executor: TaskExecutor; host: 'claude' | 'codex'; version: string | null }
  | { ok: false; message: string; details: string[] };

/**
 * Turnkey host bootstrap. Detects the selected CLI (honest gate — a missing or
 * failing binary blocks, nothing is simulated), builds the real PID-owning
 * process controller with the project config, and wraps it in a
 * SupervisedExecutor driven by the FULL `config.supervisor` policy (real
 * heartbeat/deadline/replacement budget — never the neutered in-process
 * default). The returned executor is injected into WorkflowDeps.executor so the
 * normal workflow runs end-to-end against the host without the operator ever
 * writing a JSON-RPC loop.
 */
export async function buildHostExecutor(opts: HostExecutorOptions): Promise<HostBootstrap> {
  const spawner = opts.spawner ?? nodeSpawner;
  const emit = opts.onProgress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const bin = opts.provider;
  const detect = opts.provider === 'claude' ? detectClaudeCli : detectCodexCli;

  const availability: HostAvailability = await detect(opts.projectRoot, bin, spawner);
  if (!availability.available) {
    return {
      ok: false,
      message: `Host CLI "${bin}" indisponível (--host ${opts.provider}).`,
      details: [
        `Instale "${bin}" e garanta que "${bin} --version" funcione no PATH.`,
        'Sem o CLI do host o RIJO não executa agentes turnkey — nada é simulado.',
      ],
    };
  }
  emit(`[rijo host] ${opts.provider} disponível (${availability.version ?? 'versão desconhecida'})`);

  const onSpawn = (pid: number | null): void =>
    emit(`[rijo host] ${opts.provider}: tentativa iniciada (pid ${pid ?? 'desconhecido'})`);

  const controller =
    opts.provider === 'claude'
      ? new ClaudeProcessController({ config: opts.config, projectRoot: opts.projectRoot, onSpawn })
      : new CodexProcessController({ config: opts.config, projectRoot: opts.projectRoot, onSpawn });

  const executor = new SupervisedExecutor({
    controller,
    config: opts.config.supervisor,
    paths: opts.paths,
    capabilities: HOST_CAPABILITIES,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });

  return { ok: true, executor, host: opts.provider, version: availability.version };
}

/**
 * Resolve the effective host provider: an explicit `--host` flag wins over
 * `config.host.provider`, which defaults to 'none'. An unrecognized flag is a
 * usage error (returned as `{ error }`, never silently ignored).
 */
export function resolveHostProvider(
  flag: string | undefined,
  config: RijoConfig,
): HostProvider | { error: string } {
  if (flag !== undefined) {
    if (flag === 'claude' || flag === 'codex' || flag === 'none') return flag;
    return { error: `--host inválido "${flag}". Use claude, codex ou none.` };
  }
  return config.host.provider;
}
