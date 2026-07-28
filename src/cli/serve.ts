import type { ProgressSink } from '../core/progress.js';
import type { RunnerCapabilities } from '../agents/runner.js';
import type { WorkflowDeps, WorkflowOutcome } from '../workflows/shared.js';
import { RpcAgentRunner, StdioTransport, coreCapabilities, type RpcTransport } from '../agents/rpc.js';
import { newWorkflow } from '../workflows/new.js';
import { runWorkflow } from '../workflows/run.js';
import { uiWorkflow } from '../workflows/ui.js';
import { fixWorkflow } from '../workflows/fix.js';
import { checkWorkflow } from '../workflows/check.js';
import { mapWorkflow } from '../workflows/map.js';
import { createWorkflowEpoch } from '../core/workflow-epoch.js';

const DEFAULT_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: false, browser: false };

/** Each workflow request gets at most this long before deadline unwind begins. */
const DEFAULT_WORKFLOW_DEADLINE_MS = 60 * 60 * 1000;
/** How long a coordinated shutdown waits for in-flight work to drain. */
const DEFAULT_SHUTDOWN_GRACE_MS = 5 * 1000;
/**
 * Extra time, past the deadline, a workflow gets to actually settle (its
 * agent.runTask calls cancelled, its promise resolved, its lock released)
 * before the bridge gives up waiting and declares the run state inconsistent.
 * Two workflows must never overlap on the same repo, so the queue stays
 * blocked past this cap rather than risk it.
 */
const DEFAULT_WORKFLOW_UNWIND_MARGIN_MS = 30 * 1000;

export interface ServeOptions {
  /** Per-workflow deadline (ms). Expired → cancel in-flight host calls and unwind. */
  workflowDeadlineMs?: number;
  /**
   * Hard cap (ms), on top of the deadline, for the deadlined workflow to
   * actually settle after its in-flight host calls are cancelled. Exceeding
   * this reports WORKFLOW_UNWIND_TIMEOUT and keeps the queue blocked until the
   * workflow truly settles — the queue never advances with the old run alive.
   */
  workflowUnwindMarginMs?: number;
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
 * handled strictly sequentially: each one fully settles — including unwinding
 * a deadline-exceeded run — before the next begins. A deadline never lets two
 * workflows overlap on the same repository: it cancels the run's in-flight
 * host calls and then WAITS for the run to actually finish (its lock releases)
 * before responding to the client and letting the queue advance. Only past a
 * hard unwind cap does the bridge give up waiting; even then it keeps the
 * queue blocked and reports WORKFLOW_UNWIND_TIMEOUT rather than risk two live
 * workflows.
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
  const unwindMarginMs = options.workflowUnwindMarginMs ?? DEFAULT_WORKFLOW_UNWIND_MARGIN_MS;
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
          return handleWorkflowRequest(transport, cwd, name, id, params, deadlineMs, unwindMarginMs, (r) => {
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

export interface RaceOutcome {
  /** The deadline fired before `work` settled on its own. */
  deadlineHit: boolean;
  /** Past deadlineHit, `work` did not settle within the unwind margin either. */
  unwindTimedOut: boolean;
}

/**
 * Race `work` (assumed to never reject — see callers) against `deadlineMs`.
 *
 * On a plain timeout, `work` wins the race or the deadline does; nothing else
 * happens. When the deadline wins, `onDeadline()` fires immediately (cancel
 * the run's in-flight host calls) and this function then WAITS for `work` to
 * actually settle — bounded by a hard `unwindMarginMs` cap on top of the
 * deadline. Exceeding the cap fires `onUnwindTimeout()` right away (so a
 * caller can surface an explicit inconsistent-state signal at the moment it
 * happens) but this function still does not return until `work` truly
 * settles: the caller is expected to treat "not yet returned" as "do not
 * advance the queue" — two workflows must never run concurrently.
 *
 * Exported standalone (independent of any real workflow/dispatch) so the
 * deadline/cancel/hard-cap state machine is unit-testable with a manually
 * controlled `work` promise instead of a real, possibly-retrying workflow.
 */
export async function raceWithUnwind(
  work: Promise<void>,
  deadlineMs: number,
  unwindMarginMs: number,
  onDeadline: () => void,
  onUnwindTimeout: () => void,
): Promise<RaceOutcome> {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineHit = false;
  const deadline = new Promise<void>((res) => {
    if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) return; // no deadline
    deadlineTimer = setTimeout(() => {
      deadlineHit = true;
      res();
    }, deadlineMs);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
  });

  await Promise.race([work, deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  if (!deadlineHit) return { deadlineHit: false, unwindTimedOut: false };

  // Unblock the workflow: cancel its in-flight host calls so it can unwind.
  onDeadline();

  // Wait for the workflow's own promise to actually settle — its lock is
  // released by withLock's `finally` only once it does — bounded by a hard
  // cap on top of the deadline so a wedged unwind can never block forever.
  let unwindTimedOut = false;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  const cap = new Promise<void>((res) => {
    capTimer = setTimeout(() => {
      unwindTimedOut = true;
      res();
    }, unwindMarginMs);
    if (typeof capTimer.unref === 'function') capTimer.unref();
  });

  await Promise.race([work, cap]);
  if (capTimer) clearTimeout(capTimer);

  if (unwindTimedOut) {
    // Past the hard cap: the run state is inconsistent — the old workflow may
    // still be alive. Fire the inconsistent-state signal now, at the moment
    // it happens, but keep waiting for the real settle before returning —
    // never let the caller advance with the old run possibly still live.
    onUnwindTimeout();
    await work;
  }
  return { deadlineHit: true, unwindTimedOut };
}

async function handleWorkflowRequest(
  transport: RpcTransport,
  cwd: string,
  name: string,
  id: unknown,
  params: Record<string, unknown>,
  deadlineMs: number,
  unwindMarginMs: number,
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
  const deps: WorkflowDeps = {
    runner,
    sink,
    workflowEpoch: createWorkflowEpoch(),
  };

  // Exactly one response per workflow id — whichever of {completion, deadline,
  // unwind-timeout} wins.
  let responded = false;
  const respond = (msg: unknown): void => {
    if (responded) return;
    responded = true;
    transport.send(msg);
  };

  // Once the deadline claims this request, the workflow's own eventual
  // completion must NOT reach the client — even if it unwinds gracefully into
  // a legitimate `blocked`/`failed` WorkflowOutcome (a real, resolved value,
  // not a thrown error). The client must see the deadline error, sent only
  // after that graceful settle actually happens.
  let deadlineClaimed = false;
  const respondUnlessDeadlineClaimed = (msg: unknown): void => {
    if (deadlineClaimed) return;
    respond(msg);
  };

  // `work` never rejects: dispatch()'s try/catch always ends in a respond()
  // call and a normal return, so it is always safe for raceWithUnwind to keep
  // awaiting it without a .catch — nothing here can become an unhandled
  // rejection.
  const work = (async () => {
    try {
      const outcome = await dispatch(name, cwd, params, deps);
      respondUnlessDeadlineClaimed({ type: 'response', id, result: outcome });
    } catch (err) {
      respondUnlessDeadlineClaimed({ type: 'response', id, error: err instanceof Error ? err.message : String(err) });
    }
  })();

  const outcome = await raceWithUnwind(
    work,
    deadlineMs,
    unwindMarginMs,
    () => {
      deadlineClaimed = true;
      runner.cancelAll('WORKFLOW_DEADLINE', true);
    },
    () => respond({ type: 'response', id, error: 'WORKFLOW_UNWIND_TIMEOUT' }),
  );
  if (outcome.deadlineHit && !outcome.unwindTimedOut) {
    respond({ type: 'response', id, error: 'WORKFLOW_DEADLINE_EXCEEDED' });
  }

  runner.dispose();
}

function dispatch(
  name: string,
  cwd: string,
  params: Record<string, unknown>,
  deps: WorkflowDeps,
): Promise<WorkflowOutcome> {
  switch (name) {
    case 'map':
      return mapWorkflow(
        cwd,
        {
          full: Boolean(params.full),
          paths: (params.paths as string[] | undefined) ?? [],
          query: params.query as string | undefined,
          status: Boolean(params.status),
        },
        deps,
      );
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
      throw new Error(`unknown workflow "${name}" (expected map|new|run|ui|fix|check)`);
  }
}
