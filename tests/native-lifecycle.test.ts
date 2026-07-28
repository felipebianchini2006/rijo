import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeLifecycleLedger,
  createNativeLifecycleEvent,
} from '../src/agents/native-lifecycle.js';
import { createNativeRequestV2 } from '../src/agents/native-results.js';
import { AgentTaskSchema } from '../src/agents/protocol.js';
import { RijoPaths } from '../src/core/paths.js';
import { TaskRecordSchema } from '../src/core/schemas/index.js';
import { TaskStore } from '../src/supervisor/store.js';
import { cleanup, tmpProject } from './helpers.js';

describe('native lifecycle supervision', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) cleanup(root);
  });

  function fixture() {
    const root = tmpProject('rijo-native-lifecycle-');
    roots.push(root);
    const paths = new RijoPaths(root);
    const store = new TaskStore(paths);
    const record = TaskRecordSchema.parse({
      logical_task_id: 'task-01',
      attempt_id: 'attempt-01',
      generation: 1,
      lease_id: 'lease-01',
      idempotency_key: 'task-01:1',
      role: 'worker',
      state: 'QUEUED',
      created_at: new Date().toISOString(),
    });
    store.create(record);
    const task = AgentTaskSchema.parse({
      id: 'task-01',
      role: 'worker',
      objective: 'Implement the bounded task.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/task.ts'],
      acceptance_criteria: ['The task is complete.'],
      verification_commands: ['npm test'],
      return_format: 'NativeResultV2.',
      attempt: {
        logical_task_id: record.logical_task_id,
        attempt_id: record.attempt_id,
        generation: record.generation,
        lease_id: record.lease_id,
        idempotency_key: record.idempotency_key,
        canonical_baseline_hash: null,
        workspace_id: null,
      },
    });
    return {
      root,
      paths,
      store,
      ledger: new NativeLifecycleLedger(paths),
      request: createNativeRequestV2(task),
    };
  }

  it('persists dispatch before host start and records the real host handle', () => {
    const { paths, store, ledger, request } = fixture();

    ledger.dispatch(request);
    ledger.record(createNativeLifecycleEvent(request, 'start', {
      host: 'claude',
      host_handle: 'agent-42',
    }));

    const record = store.read('task-01');
    expect(record?.state).toBe('RUNNING');
    expect(record?.host).toBe('claude');
    expect(record?.host_native_handle).toBe('agent-42');
    const events = fs
      .readFileSync(path.join(paths.runtimeDir, 'native-lifecycle.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual(['dispatch', 'start']);
  });

  it('rejects a lifecycle event from an old lease', () => {
    const { ledger, request } = fixture();
    ledger.dispatch(request);
    const stale = createNativeLifecycleEvent(
      { ...request, lease_id: 'old-lease' },
      'progress',
      { host: 'codex', detail: 'Still running.' },
    );

    expect(() => ledger.record(stale)).toThrow('does not match the active native request');
  });

  it('fences an attempt when cancellation is unavailable', () => {
    const { store, ledger, request } = fixture();
    ledger.dispatch(request);
    ledger.record(createNativeLifecycleEvent(request, 'start', {
      host: 'codex',
      host_handle: 'agent-99',
    }));
    ledger.record(createNativeLifecycleEvent(request, 'timeout', {
      host: 'codex',
      detail: 'The hard deadline expired.',
    }));
    ledger.record(createNativeLifecycleEvent(request, 'cancel-unavailable', {
      host: 'codex',
      detail: 'The host does not expose cancellation.',
    }));

    const record = store.read('task-01');
    expect(record?.state).toBe('ORPHANED');
    expect(record?.revoked_leases).toContain('lease-01');
    const event = ledger.read().at(-1);
    expect(event?.event).toBe('cancel-unavailable');
    expect(event?.termination_confirmed).toBe(false);
  });

  it('records confirmed cancellation without claiming more than the host confirmed', () => {
    const { store, ledger, request } = fixture();
    ledger.dispatch(request);
    ledger.record(createNativeLifecycleEvent(request, 'start', {
      host: 'claude',
      host_handle: 'agent-10',
    }));
    ledger.record(createNativeLifecycleEvent(request, 'timeout', { host: 'claude' }));
    ledger.record(createNativeLifecycleEvent(request, 'cancelled', {
      host: 'claude',
      detail: 'The host confirmed cancellation.',
    }));

    expect(store.read('task-01')?.state).toBe('CANCELLED');
    expect(ledger.read().at(-1)?.termination_confirmed).toBe(true);
  });

  it('waits for deterministic result validation after the native host completes', () => {
    const { store, ledger, request } = fixture();
    ledger.dispatch(request);
    ledger.record(createNativeLifecycleEvent(request, 'start', {
      host: 'claude',
      host_handle: 'agent-11',
    }));
    ledger.record(createNativeLifecycleEvent(request, 'complete', {
      host: 'claude',
      detail: 'The result bundle is ready.',
    }));

    const record = store.read('task-01');
    expect(record?.state).toBe('AWAITING_NATIVE_RESULT');
    expect(record?.last_error).toContain('deterministic core must validate');
  });
});
