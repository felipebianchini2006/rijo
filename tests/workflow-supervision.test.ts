import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { RijoPaths } from '../src/core/paths.js';
import { AgentTaskSchema, type AgentResult } from '../src/agents/protocol.js';
import { SupervisorConfigSchema, type SupervisorConfig } from '../src/core/schemas/index.js';
import type {
  HostAgentController,
  HostAttemptHandle,
  HostLiveness,
  CancelReceipt,
  HostAttemptStatus,
  SupervisedAgentTask,
} from '../src/hosts/controller.js';
import { SupervisedExecutor } from '../src/workflows/executor.js';
import { TaskStore } from '../src/supervisor/store.js';
import { tmpProject, cleanup, writePlanFile, deps, newMappedReference, ok, phaseReqIds } from './helpers.js';

// Any dangling runner promise from a deliberately-hung attempt must not surface
// as an unhandled rejection (it stays pending, never rejects).
const unhandled: unknown[] = [];
beforeAll(() => {
  process.on('unhandledRejection', (r) => unhandled.push(r));
});

const workflowTestTimeout = process.platform === 'win32' ? 120_000 : 15_000;

/** Short real-time supervisor policy so deadlines fire in milliseconds. */
function fastSupervisor(over: Partial<Record<string, unknown>> = {}): SupervisorConfig {
  return SupervisorConfigSchema.parse({
    heartbeat_interval_ms: 20,
    heartbeat_grace_ms: 20,
    no_progress_timeout_ms: { lead: 60, planner: 60, worker: 60, reviewer: 60, researcher: 60, qa: 60 },
    hard_timeout_ms: { lead: 200, planner: 200, worker: 200, reviewer: 200, researcher: 200, qa: 200 },
    cancel_grace_ms: 20,
    hard_kill_grace_ms: 20,
    max_replacements_per_task: 0,
    replacement_backoff_ms: [],
    ...over,
  });
}

const twoParallelTasks = (phaseId: string, reqIds: string[]) => ({
  phase: phaseId,
  tasks: [
    { id: 'T01', name: 'a', requirement_ids: reqIds, technical_justification: null, files: ['src/a.ts'], mapped_references: [newMappedReference('src/a.ts')], write_scope: ['src/a.ts'], depends_on: [], parallel: true, tdd: false, tests: ['echo ok'], evidence_expected: 'e', done: false },
    { id: 'T02', name: 'b', requirement_ids: [], technical_justification: 'x', files: ['src/b.ts'], mapped_references: [newMappedReference('src/b.ts')], write_scope: ['src/b.ts'], depends_on: [], parallel: true, tdd: false, tests: [], evidence_expected: 'e', done: false },
  ],
});

describe('workflow supervision (P0.6 item 3)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => {
    cleanup(root);
    expect(unhandled).toEqual([]);
    unhandled.length = 0;
  });

  it('a stuck task in a batch does not block the others (independent supervision)', async () => {
    const d = deps(root, { planPayload: (p) => twoParallelTasks(p, phaseReqIds(root, p)) });
    // T02's agent hangs forever; the supervisor must bound it while T01 lands.
    d.runner.on((t) => t.id === 'exec-01-T02', () => new Promise<AgentResult>(() => {}));
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await runWorkflow(root, {}, { ...d, supervisorConfig: fastSupervisor() });

    // The batch did NOT hang: it completed with a blocked phase (T02 exhausted),
    // and BOTH workers were actually dispatched — T01 was not starved by T02.
    expect(outcome.status).toBe('blocked');
    const executed = d.runner.executed.map((t) => t.id);
    expect(executed).toContain('exec-01-T01');
    expect(executed).toContain('exec-01-T02');
    // T02's supervised record ended EXHAUSTED (bounded, not applied)
    const t02 = new TaskStore(new RijoPaths(root)).read('exec-01-T02');
    expect(t02?.state).toBe('EXHAUSTED');
  }, workflowTestTimeout);

  it('exhaustion after replacements returns BLOCKED with an actionable diagnostic', async () => {
    const d = deps(root);
    // The worker always fails; with 2 replacements the supervisor exhausts it.
    d.runner.on((t) => t.id === 'exec-01-T01', (t) => ({
      task_id: t.id, ok: false, summary: 'worker boom', files_written: [], payload: null, scope_requests: [],
      attempt_id: null, generation: null, lease_id: null,
    }));
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await runWorkflow(root, {}, {
      ...d,
      supervisorConfig: fastSupervisor({ max_replacements_per_task: 2, replacement_backoff_ms: [0, 0] }),
    });

    expect(outcome.status).toBe('blocked');
    const detail = (outcome.details ?? []).join('\n');
    expect(detail).toMatch(/exhausted after 2 replacement/);
    expect(detail).toContain('worker boom');
    // supervised record is terminal EXHAUSTED, never looping
    const rec = new TaskStore(new RijoPaths(root)).read('exec-01-T01');
    expect(rec?.state).toBe('EXHAUSTED');
    expect(rec?.replacement_count).toBe(2);
  }, workflowTestTimeout);

  it('a stale-identity result is never applied (executor preserves LATE_OR_STALE fencing)', async () => {
    // A controller that delivers a result carrying the WRONG generation/lease —
    // exactly the shape of a duplicated/echoed delivery from a superseded
    // attempt. The supervised executor must discard it and bound the attempt to
    // a BLOCKED outcome rather than accept the stale success.
    class StaleController implements HostAgentController {
      readonly host = 'stale';
      async start(sup: SupervisedAgentTask): Promise<HostAttemptHandle> {
        const a = sup.task.attempt!;
        const result: AgentResult = {
          task_id: sup.task.id, ok: true, summary: 'stale success', files_written: [], payload: { done: true },
          scope_requests: [], attempt_id: 'someone-elses-attempt', generation: a.generation + 5, lease_id: 'revoked-lease',
        };
        return { attempt_id: a.attempt_id, lease_id: a.lease_id, generation: a.generation, host: this.host, result: Promise.resolve(result) };
      }
      async heartbeat(): Promise<HostLiveness> { return { alive: false, detail: 'gone' }; }
      async requestCancel(): Promise<CancelReceipt> { return { requested: true, acknowledged: true }; }
      async query(): Promise<HostAttemptStatus> { return { kind: 'running' }; }
      async dispose(): Promise<void> {}
    }

    const paths = new RijoPaths(root);
    const executor = new SupervisedExecutor({
      controller: new StaleController(),
      config: fastSupervisor(),
      paths,
      capabilities: { subagents: true, parallelism: true, browser: false },
    });
    const task = AgentTaskSchema.parse({ id: 'exec-stale-T01', role: 'worker', objective: 'do it', return_format: 'JSON', write_scope: ['src/x.ts'] });

    const result = await executor.run({ task, role: 'worker' });

    // The stale success was rejected; the attempt was bounded to a BLOCKED/CANCELLED result.
    expect(result.ok).toBe(false);
    expect(result.summary).not.toContain('stale success');
    // The durable log recorded the stale delivery as discarded.
    const events = new TaskStore(paths).readEvents('exec-stale-T01');
    expect(events.some((e) => e.type === 'late_or_stale_result')).toBe(true);
  }, workflowTestTimeout);
});
