import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serve } from '../src/cli/serve.js';
import type { RpcTransport } from '../src/agents/rpc.js';
import { AgentResultSchema, type AgentTask, type AgentResult } from '../src/agents/protocol.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRoadmap } from '../src/core/roadmap.js';
import { tmpProject, cleanup, writePlanFile, EXTRACTION_PAYLOAD } from './helpers.js';

/**
 * Phase plan payload the fake host returns — self-contained (does not depend on
 * helpers.planPayloadFor) and covers the phase's requirement so plan lint
 * passes regardless of whether run.ts enforces phaseRequirements coverage.
 * Phase 01 → M001-REQ-001, phase 02 → M001-REQ-002 (per EXTRACTION_PAYLOAD).
 */
function localPlanPayload(phaseId: string) {
  const reqId = `M001-REQ-${phaseId === '02' ? '002' : '001'}`;
  return {
    phase: phaseId,
    tasks: [
      {
        id: 'T01',
        name: 'Implementar módulo',
        requirement_ids: [reqId],
        technical_justification: 'infra da fase',
        files: ['src/a.ts'],
        write_scope: ['src/a.ts'],
        depends_on: [],
        parallel: false,
        tdd: true,
        tests: ['echo test-a'],
        evidence_expected: 'testes passam',
        done: false,
      },
      {
        id: 'T02',
        name: 'Integrar módulo',
        requirement_ids: [reqId],
        technical_justification: 'integração',
        files: ['src/b.ts'],
        write_scope: ['src/b.ts'],
        depends_on: ['T01'],
        parallel: false,
        tdd: false,
        tests: [],
        evidence_expected: 'build passa',
        done: false,
      },
    ],
  };
}

/**
 * In-memory bidirectional transport. `send` carries core → host messages;
 * `deliver` carries host → core messages. Delivery is asynchronous (microtask)
 * so the promises awaited inside serve's workflow can resolve — never timers,
 * never Date.now/Math.random.
 */
class LoopbackTransport implements RpcTransport {
  private readonly coreHandlers: Array<(msg: any) => void> = [];
  /** The test (host) subscribes here to observe core → host traffic. */
  public onCore: ((msg: any) => void) | null = null;

  send(msg: unknown): void {
    const h = this.onCore;
    if (h) queueMicrotask(() => h(msg));
  }

  onMessage(cb: (msg: any) => void): void {
    this.coreHandlers.push(cb);
  }

  /** Host → core: fan out to every core-side listener (serve + RpcAgentRunner). */
  deliver(msg: unknown): void {
    for (const h of this.coreHandlers) queueMicrotask(() => h(msg));
  }
}

function okResult(task: AgentTask, extra: Partial<AgentResult> = {}): AgentResult {
  return AgentResultSchema.parse({
    task_id: task.id,
    ok: true,
    summary: `host done ${task.id}`,
    files_written: [],
    payload: null,
    scope_requests: [],
    ...extra,
  });
}

/**
 * The fake HOST's agent runtime — mirrors tests/helpers.ts standardRunner,
 * matched top-down in the same precedence order.
 */
function fakeHostResult(task: AgentTask, root: string): AgentResult {
  // worker executor: write each non-glob scope path into the project
  if (task.role === 'worker' && task.id.startsWith('exec-')) {
    const written: string[] = [];
    const base = task.workspace?.root ?? root;
    for (const scope of task.write_scope) {
      if (scope.includes('*')) continue;
      const target = path.join(base, scope);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `// ${task.id}\n`, 'utf8');
      written.push(scope);
    }
    return okResult(task, { files_written: written, payload: { done: true, notes: 'implemented' } });
  }
  // any reviewer (plan review / code review / visual): approve
  if (task.role === 'reviewer') {
    return okResult(task, { payload: { approved: true, findings: [] } });
  }
  // planner plan payload (but NOT the reviewer plan-review task)
  if (task.id.startsWith('plan-') && !task.id.startsWith('plan-review')) {
    const phaseId = task.id.match(/plan-(\d{2})/)?.[1] ?? '01';
    return okResult(task, { payload: localPlanPayload(phaseId) });
  }
  // spec writer: write SPEC.md to the declared write scope, report it
  if (task.id.startsWith('spec-')) {
    const specBase = task.workspace?.root ?? root;
    const specPath = path.isAbsolute(task.write_scope[0]!) ? task.write_scope[0]! : path.join(specBase, task.write_scope[0]!);
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, `# Spec\n\nCenários observáveis de aceite.\n`, 'utf8');
    return okResult(task, { files_written: [task.write_scope[0]!] });
  }
  // researcher: sources payload
  if (task.id.startsWith('new-research')) {
    return okResult(task, {
      payload: {
        summary: 'Node 24 é o Active LTS.',
        sources: [
          {
            claim: 'Node.js 24 é Active LTS',
            source: 'nodejs.org previous releases',
            url: 'https://nodejs.org/en/about/previous-releases',
            checked_at: '2026-07-23T00:00:00.000Z',
            version: '24.x',
            confidence: 'high',
            tier: 'official',
          },
        ],
      },
    });
  }
  // planner extraction
  if (task.id === 'new-extract') {
    return okResult(task, { payload: EXTRACTION_PAYLOAD });
  }
  return okResult(task);
}

interface Host {
  transport: LoopbackTransport;
  callWorkflow: (id: number, method: string, params: Record<string, unknown>) => Promise<any>;
  seenTasks: string[];
  progress: string[];
}

function startHost(dir: string): Host {
  const transport = new LoopbackTransport();
  const seenTasks: string[] = [];
  const progress: string[] = [];
  const pending = new Map<number, (msg: any) => void>();

  transport.onCore = (msg: any) => {
    if (msg.type === 'notification' && msg.method === 'progress') {
      progress.push(msg.params.line);
      return;
    }
    if (msg.type === 'response' && pending.has(msg.id)) {
      const resolve = pending.get(msg.id)!;
      pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.type === 'request' && msg.method === 'agent.runTask') {
      const task = msg.params as AgentTask;
      seenTasks.push(task.id);
      // respond asynchronously so the awaited promise inside serve resolves
      const result = fakeHostResult(task, dir);
      transport.deliver({ type: 'response', id: msg.id, result });
      return;
    }
  };

  // serve registers its onMessage synchronously here.
  void serve(transport, dir);

  const callWorkflow = (id: number, method: string, params: Record<string, unknown>): Promise<any> =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      transport.deliver({ type: 'request', method, id, params });
    });

  return { transport, callWorkflow, seenTasks, progress };
}

describe('host↔core JSON-RPC bridge', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-bridge-');
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  it('drives rijo new to completion over the transport', async () => {
    const host = startHost(root);
    const resp = await host.callWorkflow(1, 'workflow.new', { planFile: '@PLANO.md' });

    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeTruthy();
    expect(resp.result.ok).toBe(true);
    expect(resp.result.status).toBe('completed');

    // the host actually answered agent.runTask requests over the bridge
    expect(host.seenTasks).toContain('new-extract');
    expect(host.seenTasks.some((id) => id.startsWith('new-research'))).toBe(true);
    // progress notifications streamed as JSON over the same pipe
    expect(host.progress.length).toBeGreaterThan(0);

    // M001 was created on disk
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    expect(manifest.active_milestone).toBe('M001');
    expect(manifest.milestones[0]).toMatchObject({ id: 'M001', status: 'ACTIVE' });
  });

  it('drives a subsequent rijo run at least through the first phase', async () => {
    const host = startHost(root);
    const created = await host.callWorkflow(1, 'workflow.new', { planFile: '@PLANO.md' });
    expect(created.result.ok, JSON.stringify(created)).toBe(true);

    const before = host.seenTasks.length;
    const runResp = await host.callWorkflow(2, 'workflow.run', { target: 'all' });
    // a response (result or handled error) came back over the bridge
    expect(runResp.id).toBe(2);
    expect('result' in runResp || 'error' in runResp).toBe(true);

    // the run drove real orchestration work over the bridge: spec + first-phase
    // execution tasks were dispatched to the host and answered.
    const runTasks = host.seenTasks.slice(before);
    expect(runTasks).toContain('spec-01');
    expect(runTasks.some((id) => id.startsWith('exec-01-'))).toBe(true);

    // the host's spec reply was applied through the orchestrator: SPEC.md on disk
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const m = manifest.milestones[0]!;
    const mdir = paths.milestoneDir(m.id, m.slug);
    const phase01 = readRoadmap(path.join(mdir, 'ROADMAP.md')).phases.find((p) => p.id === '01')!;
    const specPath = path.join(mdir, 'phases', `01-${phase01.slug}`, 'SPEC.md');
    expect(fs.existsSync(specPath), specPath).toBe(true);
  });
});
