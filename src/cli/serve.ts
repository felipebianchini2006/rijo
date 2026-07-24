import type { ProgressSink } from '../core/progress.js';
import type { RunnerCapabilities } from '../agents/runner.js';
import type { WorkflowDeps, WorkflowOutcome } from '../workflows/shared.js';
import { RpcAgentRunner, StdioTransport, coreCapabilities, type RpcTransport } from '../agents/rpc.js';
import { newWorkflow } from '../workflows/new.js';
import { runWorkflow } from '../workflows/run.js';
import { uiWorkflow } from '../workflows/ui.js';
import { fixWorkflow } from '../workflows/fix.js';
import { checkWorkflow } from '../workflows/check.js';

const DEFAULT_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: false, browser: false };

/** Each workflow request gets at most this long before the queue is force-advanced. */
const DEFAULT_WORKFLOW_DEADLINE_MS = 60 * 60 * 1000;
/** How long a coordinated shutdown waits for in-flight work to drain. */
const DEFAULT_SHUTDOWN_GRACE_MS = 5 * 1000;

export interface ServeOptions {
  /** Per-workflow deadline (ms). Expired → error response, queue advances. */
  workflowDeadlineMs?: number;
  /** Coordinated-shutdown grace period (ms). */
  shutdownGraceMs?: number;
  /**
   * Install process SIGINT/SIGTERM/pipe handlers. Defaults to true only for the
   * real stdio transport — never for an injected transport (tests drive their own).
   */
  installSignalHandlers?: boolean;
}

/**
 * Bridge server: exposes the deterministic RIJO orchestrator to a host over a
 * line-delimited JSON-RPC transport (stdio by default). On start it announces
 * `host.capabilities` (protocol v2). The host drives a workflow by sending
 * `{type:'request', method:'workflow.<name>', id, params}`; as the workflow
 * runs, the core sends `agent.runTask` requests the host answers over the same
 * pipe. Progress is streamed as `progress` notifications. Workflow requests are
 * handled sequentially, each under a deadline so the queue can never wedge.
 *
 * Shutdown is coordinated: SIGINT/SIGTERM/pipe-error/stdin-EOF announce
 * `host.shutdown`, cancel in-flight host-side work, wait a bounded grace, then
 * resolve. With an injectable transport (tests), signal handlers are NOT
 * installed and the promise stays pending until the transport ends — the caller
 * drives messages directly.
 *
 * NOTHING non-JSON is ever written to stdout.
 */
export async function serve(
  transport: RpcTransport = new StdioTransport(),
  cwd = process.cwd(),
  options: ServeOptions = {},
): Promise<void> {
  const deadlineMs = options.workflowDeadlineMs ?? DEFAULT_WORKFLOW_DEADLINE_MS;
  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const isStdio = transport instanceof StdioTransport;
  const installSignals = options.installSignalHandlers ?? isStdio;

  return new Promise<void>((resolve) => {
    // Serialize host→core workflow requests: each fully completes (including the
    // agent.runTask round-trips awaited inside it) before the next begins.
    let chain: Promise<void> = Promise.resolve();
    let activeRunner: RpcAgentRunner | null = null;
    let shuttingDown = false;
    let resolved = false;

    const signalCleanups: Array<() => void> = [];
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      for (const c of signalCleanups) c();
      resolve();
    };

    const shutdown = (reason: string): void => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      // Announce coordinated teardown and cancel in-flight host-side work.
      transport.send({ type: 'notification', method: 'host.shutdown', params: { reason } });
      activeRunner?.cancelAll('HOST_DISCONNECTED', true);
      // Resolve as soon as the queue drains, but never wait past the grace window.
      const timer = setTimeout(finish, graceMs);
      if (typeof timer.unref === 'function') timer.unref();
      chain.finally(() => finish());
    };

    // v2 handshake: announce capabilities on start (v1 hosts simply ignore it).
    transport.send({ type: 'notification', method: 'host.capabilities', params: coreCapabilities() });

    transport.onMessage((msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'notification' && msg.method === 'host.shutdown') {
        shutdown('host requested shutdown');
        return;
      }
      if (msg.type !== 'request' || typeof msg.method !== 'string') return; // agent responses routed by RpcAgentRunner

      if (msg.method === 'host.capabilities') {
        transport.send({ type: 'response', id: msg.id, result: coreCapabilities() });
        return;
      }
      if (msg.method === 'host.shutdown') {
        transport.send({ type: 'response', id: msg.id, result: { ok: true } });
        shutdown('host requested shutdown');
        return;
      }
      if (!msg.method.startsWith('workflow.')) return;

      const name = msg.method.slice('workflow.'.length);
      const id = msg.id;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      chain = chain
        .then(() => {
          if (shuttingDown) {
            transport.send({ type: 'response', id, error: 'SHUTTING_DOWN' });
            return;
          }
          return handleWorkflowRequest(transport, cwd, name, id, params, deadlineMs, (r) => {
            activeRunner = r;
          });
        })
        .finally(() => {
          activeRunner = null;
        });
    });

    transport.onEnd?.(() => shutdown('stdin closed'));
    transport.onError?.(() => shutdown('transport error'));

    if (installSignals) {
      const onSignal = (): void => shutdown('signal');
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      signalCleanups.push(() => process.removeListener('SIGINT', onSignal));
      signalCleanups.push(() => process.removeListener('SIGTERM', onSignal));
    }
  });
}

async function handleWorkflowRequest(
  transport: RpcTransport,
  cwd: string,
  name: string,
  id: unknown,
  params: Record<string, unknown>,
  deadlineMs: number,
  setRunner: (runner: RpcAgentRunner) => void,
): Promise<void> {
  const capabilities = (params.capabilities as RunnerCapabilities | undefined) ?? DEFAULT_CAPABILITIES;
  const runner = new RpcAgentRunner(transport, capabilities);
  setRunner(runner);
  const sink: ProgressSink = {
    render(line: string) {
      transport.send({ type: 'notification', method: 'progress', params: { line } });
    },
  };
  // shell/git default to the real ones inside createContext.
  const deps: WorkflowDeps = { runner, sink };

  // Exactly one response per workflow id — whichever of {completion, deadline} wins.
  let responded = false;
  const respond = (msg: unknown): void => {
    if (responded) return;
    responded = true;
    transport.send(msg);
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((res) => {
    if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) return; // no deadline
    deadlineTimer = setTimeout(() => {
      respond({ type: 'response', id, error: 'WORKFLOW_DEADLINE_EXCEEDED' });
      // Unblock the workflow: cancel its in-flight host calls so it unwinds.
      runner.cancelAll('WORKFLOW_DEADLINE', true);
      res();
    }, deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  });

  const work = (async () => {
    try {
      const outcome = await dispatch(name, cwd, params, deps);
      respond({ type: 'response', id, result: outcome });
    } catch (err) {
      respond({ type: 'response', id, error: err instanceof Error ? err.message : String(err) });
    }
  })();

  await Promise.race([work, deadline]);
  // If the deadline won, the workflow keeps running in the background; swallow
  // its eventual settlement so it never becomes an unhandled rejection.
  work.catch(() => {});
  if (deadlineTimer) clearTimeout(deadlineTimer);
  runner.dispose();
}

function dispatch(
  name: string,
  cwd: string,
  params: Record<string, unknown>,
  deps: WorkflowDeps,
): Promise<WorkflowOutcome> {
  switch (name) {
    case 'new':
      return newWorkflow(
        cwd,
        {
          planFile: String(params.planFile ?? ''),
          next: Boolean(params.next),
          run: Boolean(params.run),
          ui: params.ui as string | undefined,
        },
        deps,
      );
    case 'run':
      return runWorkflow(cwd, { target: params.target as string | undefined }, deps);
    case 'ui':
      return uiWorkflow(cwd, { input: String(params.input ?? '') }, deps);
    case 'fix':
      return fixWorkflow(
        cwd,
        {
          description: String(params.description ?? ''),
          evidenceFiles: (params.evidenceFiles as string[] | undefined) ?? [],
        },
        deps,
      );
    case 'check':
      return checkWorkflow(cwd, { fix: Boolean(params.fix), production: Boolean(params.production) }, deps);
    default:
      throw new Error(`unknown workflow "${name}" (expected new|run|ui|fix|check)`);
  }
}
