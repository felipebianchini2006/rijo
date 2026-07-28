import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  AgentTaskSchema,
  type AgentResult,
} from '../src/agents/protocol.js';
import type { AgentRunner } from '../src/agents/runner.js';
import { createWorkflowEpoch } from '../src/core/workflow-epoch.js';
import { buildHostPrompt } from '../src/hosts/parse.js';
import { ProcessController } from '../src/supervisor/processController.js';
import { InProcessController } from '../src/supervisor/runnerController.js';

function supervisedTask() {
  return AgentTaskSchema.parse({
    id: 'identity-task',
    role: 'worker',
    objective: 'Return the exact attempt identity.',
    return_format: 'One result.',
    attempt: {
      workflow_epoch: createWorkflowEpoch(),
      logical_task_id: 'identity-task',
      attempt_id: 'attempt-current',
      generation: 3,
      lease_id: 'lease-current',
      idempotency_key: 'idem-current',
    },
  });
}

function mismatchedResult(): AgentResult {
  return {
    task_id: 'identity-task',
    ok: true,
    summary: 'Misdirected host result.',
    files_written: [],
    payload: null,
    scope_requests: [],
    workflow_epoch: createWorkflowEpoch(),
    attempt_id: 'attempt-stale',
    generation: 2,
    lease_id: 'lease-stale',
  };
}

describe('host result identity', () => {
  it('keeps a mismatched in-process host identity unchanged', async () => {
    const raw = mismatchedResult();
    const runner: AgentRunner = {
      capabilities: { subagents: true, parallelism: false, browser: false },
      async runTask() {
        return raw;
      },
    };
    const task = supervisedTask();
    const controller = new InProcessController(runner);
    const handle = await controller.start(
      { task, hard_deadline_at: new Date().toISOString() },
      new AbortController().signal,
    );

    await expect(handle.result).resolves.toEqual(raw);
  });

  it('keeps a mismatched process host identity unchanged', async () => {
    const raw = mismatchedResult();
    const task = supervisedTask();
    const controller = new ProcessController({
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: os.tmpdir(),
        env: {},
      }),
      parseResult: () => raw,
    });
    const handle = await controller.start(
      { task, hard_deadline_at: new Date().toISOString() },
      new AbortController().signal,
    );

    await expect(handle.result).resolves.toEqual(raw);
    await controller.dispose(handle);
  });

  it('requires the host to echo every exact supervised identity field', () => {
    const task = supervisedTask();
    const prompt = buildHostPrompt(task);

    expect(prompt).toContain(`"workflow_epoch": "${task.attempt!.workflow_epoch}"`);
    expect(prompt).toContain('"attempt_id": "attempt-current"');
    expect(prompt).toContain('"generation": 3');
    expect(prompt).toContain('"lease_id": "lease-current"');
    expect(prompt).toContain(
      'Copy `workflow_epoch`, `attempt_id`, `generation`, and `lease_id` exactly',
    );
  });
});
