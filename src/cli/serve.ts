import type { ProgressSink } from '../core/progress.js';
import type { RunnerCapabilities } from '../agents/runner.js';
import type { WorkflowDeps, WorkflowOutcome } from '../workflows/shared.js';
import { RpcAgentRunner, StdioTransport, type RpcTransport } from '../agents/rpc.js';
import { newWorkflow } from '../workflows/new.js';
import { runWorkflow } from '../workflows/run.js';
import { uiWorkflow } from '../workflows/ui.js';
import { fixWorkflow } from '../workflows/fix.js';
import { checkWorkflow } from '../workflows/check.js';

const DEFAULT_CAPABILITIES: RunnerCapabilities = { subagents: true, parallelism: false, browser: false };

/**
 * Bridge server: exposes the deterministic RIJO orchestrator to a host over a
 * line-delimited JSON-RPC transport (stdio by default). The host drives a
 * workflow by sending `{type:'request', method:'workflow.<name>', id, params}`;
 * as the workflow runs, the core sends back `agent.runTask` requests that the
 * host answers with AgentResults over the same pipe. Progress is streamed as
 * `progress` notifications. Workflow requests are handled sequentially.
 *
 * `serve` resolves when the transport signals end (stdin closes). With an
 * injectable transport (tests), it stays pending — the caller drives messages
 * directly and awaits its own responses instead of the returned promise.
 */
export async function serve(transport: RpcTransport = new StdioTransport(), cwd = process.cwd()): Promise<void> {
  return new Promise<void>((resolve) => {
    // Serialize host→core workflow requests: each fully completes (including the
    // agent.runTask round-trips awaited inside it) before the next begins.
    let chain: Promise<void> = Promise.resolve();

    transport.onMessage((msg) => {
      if (!msg || msg.type !== 'request' || typeof msg.method !== 'string') return;
      if (!msg.method.startsWith('workflow.')) return; // agent responses are routed by RpcAgentRunner
      const name = msg.method.slice('workflow.'.length);
      const id = msg.id;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      chain = chain.then(() => handleWorkflowRequest(transport, cwd, name, id, params));
    });

    transport.onEnd?.(() => resolve());
  });
}

async function handleWorkflowRequest(
  transport: RpcTransport,
  cwd: string,
  name: string,
  id: unknown,
  params: Record<string, unknown>,
): Promise<void> {
  const capabilities = (params.capabilities as RunnerCapabilities | undefined) ?? DEFAULT_CAPABILITIES;
  const runner = new RpcAgentRunner(transport, capabilities);
  const sink: ProgressSink = {
    render(line: string) {
      transport.send({ type: 'notification', method: 'progress', params: { line } });
    },
  };
  // shell/git default to the real ones inside createContext.
  const deps: WorkflowDeps = { runner, sink };

  try {
    const outcome = await dispatch(name, cwd, params, deps);
    transport.send({ type: 'response', id, result: outcome });
  } catch (err) {
    transport.send({ type: 'response', id, error: err instanceof Error ? err.message : String(err) });
  }
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
