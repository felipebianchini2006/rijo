import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentTaskSchema, type AgentResult } from '../src/agents/protocol.js';
import { FakeAgentRunner } from '../src/agents/runner.js';
import { NativeResultRunner } from '../src/agents/native-results.js';
import { RijoPaths } from '../src/core/paths.js';
import {
  SupervisorConfigSchema,
  TaskRecordSchema,
} from '../src/core/schemas/index.js';
import {
  createWorkflowEpoch,
  markWorkflowOperationTerminal,
  openWorkflowOperation,
  readWorkflowOperation,
} from '../src/core/workflow-epoch.js';
import { InProcessController } from '../src/supervisor/runnerController.js';
import { Supervisor } from '../src/supervisor/supervisor.js';
import { TaskStore } from '../src/supervisor/store.js';
import { defaultExecutor } from '../src/workflows/executor.js';

function fixture(): { root: string; paths: RijoPaths } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-workflow-epoch-'));
  const paths = new RijoPaths(root);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  return { root, paths };
}

function task(id = 'repeat-task') {
  return AgentTaskSchema.parse({
    id,
    role: 'worker',
    objective: 'Return a bounded result.',
    return_format: 'Text.',
  });
}

const config = SupervisorConfigSchema.parse({
  max_replacements_per_task: 0,
  replacement_backoff_ms: [],
});

describe('workflow epoch supervision', () => {
  it('keeps exhaustion terminal inside the same workflow epoch', async () => {
    const { paths } = fixture();
    const epoch = createWorkflowEpoch();
    const runner = new FakeAgentRunner().on(() => true, (input) => ({
      task_id: input.id,
      ok: false,
      summary: 'The bounded attempt failed.',
      files_written: [],
      payload: null,
      scope_requests: [],
      workflow_epoch: null,
      attempt_id: null,
      generation: null,
      lease_id: null,
    }));
    const executor = defaultExecutor(runner, config, paths, epoch);

    const first = await executor.run({ task: task(), role: 'worker' });
    const second = await executor.run({ task: task(), role: 'worker' });

    expect(first.ok).toBe(false);
    expect(second.summary).toContain('replacement budget already exhausted');
    expect(runner.executed).toHaveLength(1);
    expect(new TaskStore(paths).read('repeat-task')).toMatchObject({
      workflow_epoch: epoch,
      state: 'EXHAUSTED',
      generation: 1,
    });
  });

  it('archives a terminal prior epoch and starts generation one for a new epoch', async () => {
    const { paths } = fixture();
    const firstEpoch = createWorkflowEpoch();
    const secondEpoch = createWorkflowEpoch();
    const firstRunner = new FakeAgentRunner();
    const firstExecutor = defaultExecutor(firstRunner, config, paths, firstEpoch);
    const first = await firstExecutor.run({ task: task(), role: 'worker' });
    const firstRecord = new TaskStore(paths).read('repeat-task')!;

    expect(first.ok).toBe(true);

    const secondRunner = new FakeAgentRunner();
    const secondExecutor = defaultExecutor(secondRunner, config, paths, secondEpoch);
    const second = await secondExecutor.run({ task: task(), role: 'worker' });
    const store = new TaskStore(paths);
    const current = store.read('repeat-task')!;

    expect(second.ok).toBe(true);
    expect(current).toMatchObject({
      workflow_epoch: secondEpoch,
      state: 'SUCCEEDED',
      generation: 1,
      replacement_count: 0,
    });
    expect(current.revoked_leases).toContain(firstRecord.lease_id);
    expect(store.readArchived('repeat-task', firstEpoch)).toEqual(firstRecord);
  });

  it('refuses a nonterminal record from another epoch and revokes its lease', async () => {
    const { paths } = fixture();
    const firstEpoch = createWorkflowEpoch();
    const secondEpoch = createWorkflowEpoch();
    const store = new TaskStore(paths);
    const prior = store.create(TaskRecordSchema.parse({
      workflow_epoch: firstEpoch,
      logical_task_id: 'repeat-task',
      attempt_id: 'attempt-old',
      generation: 1,
      lease_id: 'lease-old',
      idempotency_key: 'idem-old',
      role: 'worker',
      host: 'native',
      state: 'RUNNING',
      created_at: new Date().toISOString(),
    }));
    const runner = new FakeAgentRunner();
    const executor = defaultExecutor(runner, config, paths, secondEpoch);

    const result = await executor.run({ task: task(), role: 'worker' });
    const current = store.read('repeat-task')!;

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('durable task');
    expect(runner.executed).toHaveLength(0);
    expect(current.workflow_epoch).toBe(firstEpoch);
    expect(current.revoked_leases).toContain(prior.lease_id);
  });

  it('rejects a late result from an archived workflow epoch', async () => {
    const { paths } = fixture();
    const firstEpoch = createWorkflowEpoch();
    const secondEpoch = createWorkflowEpoch();
    const firstExecutor = defaultExecutor(new FakeAgentRunner(), config, paths, firstEpoch);
    await firstExecutor.run({ task: task(), role: 'worker' });
    const old = new TaskStore(paths).read('repeat-task')!;
    const secondExecutor = defaultExecutor(new FakeAgentRunner(), config, paths, secondEpoch);
    await secondExecutor.run({ task: task(), role: 'worker' });
    const supervisor = new Supervisor({
      controller: new InProcessController(new FakeAgentRunner()),
      config,
      paths,
      workflowEpoch: secondEpoch,
    });
    const late: AgentResult = {
      task_id: 'repeat-task',
      ok: true,
      summary: 'Late old result.',
      files_written: [],
      payload: null,
      scope_requests: [],
      workflow_epoch: firstEpoch,
      attempt_id: old.attempt_id,
      generation: old.generation,
      lease_id: old.lease_id,
    };

    expect(supervisor.ingestResult('repeat-task', late)).toBe('discarded');
    expect(new TaskStore(paths).read('repeat-task')?.workflow_epoch).toBe(secondEpoch);
  });
});

describe('workflow epoch operation marker', () => {
  it('reuses one active authorization and archives it before a new authorization', () => {
    const { paths } = fixture();
    const first = openWorkflowOperation(paths, 'start', 'start-anchor');
    const repeated = openWorkflowOperation(paths, 'start', 'start-anchor');

    expect(repeated.workflow_epoch).toBe(first.workflow_epoch);
    expect(() => openWorkflowOperation(paths, 'start', 'changed-anchor')).toThrow(
      /start is active/,
    );
    expect(() => openWorkflowOperation(paths, 'test', 'test-anchor')).toThrow(
      /start is active/,
    );

    markWorkflowOperationTerminal(paths, first.workflow_epoch, 'blocked');
    const next = openWorkflowOperation(paths, 'start', 'start-anchor');

    expect(next.workflow_epoch).not.toBe(first.workflow_epoch);
    expect(
      fs.existsSync(
        path.join(
          paths.runtimeDir,
          'workflow-epochs',
          `${first.workflow_epoch}.json`,
        ),
      ),
    ).toBe(true);
    expect(readWorkflowOperation(paths)?.workflow_epoch).toBe(next.workflow_epoch);
  });

  it('archives and regenerates an epochless native v2 bundle', () => {
    const { root } = fixture();
    const bundle = path.join(root, 'native-results.json');
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      request_file: 'native-requests.jsonl',
      results: [{
        request_id: `nreq_${'1'.repeat(64)}`,
        request_hash: '2'.repeat(64),
        logical_task_id: 'old',
        attempt_id: 'old-attempt',
        generation: 1,
        lease_id: 'old-lease',
        idempotency_key: 'old-key',
        ok: true,
        summary: 'Old result.',
      }],
    }));
    const epoch = createWorkflowEpoch();

    const runner = new NativeResultRunner(bundle, epoch);
    const regenerated = JSON.parse(fs.readFileSync(bundle, 'utf8')) as {
      active_workflow_epoch: string;
      results: unknown[];
    };

    expect(runner.workflowEpoch).toBe(epoch);
    expect(regenerated).toMatchObject({
      active_workflow_epoch: epoch,
      results: [],
    });
    expect(
      fs.readdirSync(path.join(root, 'native-v2-epochless-archive')).length,
    ).toBeGreaterThan(0);
  });

  it('does not adopt a portable checkpoint epoch after runtime state is absent', () => {
    const { paths } = fixture();
    const portableEpoch = createWorkflowEpoch();
    fs.writeFileSync(
      paths.state,
      `---\nworkflow_epoch: ${portableEpoch}\n---\n\n# STATE\n`,
    );

    const opened = openWorkflowOperation(paths, 'start', 'start-anchor');

    expect(opened.workflow_epoch).not.toBe(portableEpoch);
  });
});
