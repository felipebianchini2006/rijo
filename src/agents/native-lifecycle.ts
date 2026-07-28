import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { appendLine, ensureDir, readJsonIfExists, writeJsonAtomic } from '../core/fsx.js';
import { RijoPaths } from '../core/paths.js';
import { TaskStore } from '../supervisor/store.js';
import {
  NativeRequestV2Schema,
  type NativeRequestV2,
} from './native-results.js';

const NativeLifecycleEventNameSchema = z.enum([
  'dispatch',
  'start',
  'progress',
  'stop',
  'failure',
  'cleanup',
  'complete',
  'timeout',
  'cancelled',
  'cancel-unavailable',
]);

export const NativeLifecycleEventSchema = NativeRequestV2Schema.pick({
  request_id: true,
  request_hash: true,
  logical_task_id: true,
  attempt_id: true,
  generation: true,
  lease_id: true,
  idempotency_key: true,
}).extend({
  event: NativeLifecycleEventNameSchema,
  at: z.string().datetime(),
  host: z.string().min(1),
  host_handle: z.string().min(1).nullable().default(null),
  detail: z.string().nullable().default(null),
  termination_confirmed: z.boolean(),
});
export type NativeLifecycleEvent = z.infer<typeof NativeLifecycleEventSchema>;

type LifecycleOptions = {
  host: string;
  host_handle?: string | null;
  detail?: string | null;
};

export function createNativeLifecycleEvent(
  request: NativeRequestV2,
  event: z.infer<typeof NativeLifecycleEventNameSchema>,
  options: LifecycleOptions,
): NativeLifecycleEvent {
  return NativeLifecycleEventSchema.parse({
    request_id: request.request_id,
    request_hash: request.request_hash,
    logical_task_id: request.logical_task_id,
    attempt_id: request.attempt_id,
    generation: request.generation,
    lease_id: request.lease_id,
    idempotency_key: request.idempotency_key,
    event,
    at: new Date().toISOString(),
    host: options.host,
    host_handle: options.host_handle ?? null,
    detail: options.detail ?? null,
    termination_confirmed: event === 'cancelled',
  });
}

function fileId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function sameRequest(event: NativeLifecycleEvent, request: NativeRequestV2): boolean {
  return (
    event.request_id === request.request_id &&
    event.request_hash === request.request_hash &&
    event.logical_task_id === request.logical_task_id &&
    event.attempt_id === request.attempt_id &&
    event.generation === request.generation &&
    event.lease_id === request.lease_id &&
    event.idempotency_key === request.idempotency_key
  );
}

export class NativeLifecycleLedger {
  private readonly store: TaskStore;

  constructor(private readonly paths: RijoPaths) {
    this.store = new TaskStore(paths);
  }

  private get eventsFile(): string {
    return path.join(this.paths.runtimeDir, 'native-lifecycle.jsonl');
  }

  private requestFile(request: Pick<NativeRequestV2, 'logical_task_id' | 'attempt_id'>): string {
    return path.join(
      this.paths.runtimeDir,
      'native-requests',
      `${fileId(request.logical_task_id)}.${fileId(request.attempt_id)}.json`,
    );
  }

  dispatch(requestInput: NativeRequestV2): NativeLifecycleEvent {
    const request = NativeRequestV2Schema.parse(requestInput);
    const record = this.store.read(request.logical_task_id);
    if (!record) throw new Error(`No supervised task record exists for ${request.logical_task_id}.`);
    if (
      record.attempt_id !== request.attempt_id ||
      record.generation !== request.generation ||
      record.lease_id !== request.lease_id ||
      record.idempotency_key !== request.idempotency_key
    ) {
      throw new Error(`Native request does not match the active task record for ${request.logical_task_id}.`);
    }
    writeJsonAtomic(this.requestFile(request), request);
    const event = createNativeLifecycleEvent(request, 'dispatch', { host: record.host || 'native' });
    this.append(event);
    if (record.state === 'QUEUED' || record.state === 'AWAITING_NATIVE_RESULT') {
      this.store.transition(record, 'STARTING', {}, {
        native_request_id: request.request_id,
        native_request_hash: request.request_hash,
      });
    }
    return event;
  }

  record(eventInput: NativeLifecycleEvent): NativeLifecycleEvent {
    const event = NativeLifecycleEventSchema.parse(eventInput);
    const request = readJsonIfExists<NativeRequestV2>(this.requestFile(event));
    if (!request || !sameRequest(event, NativeRequestV2Schema.parse(request))) {
      throw new Error(`Lifecycle event does not match the active native request for ${event.logical_task_id}.`);
    }
    const record = this.store.read(event.logical_task_id);
    if (
      !record ||
      record.attempt_id !== event.attempt_id ||
      record.generation !== event.generation ||
      record.lease_id !== event.lease_id ||
      record.idempotency_key !== event.idempotency_key ||
      record.revoked_leases.includes(event.lease_id)
    ) {
      throw new Error(`Lifecycle event does not match the active task record for ${event.logical_task_id}.`);
    }

    this.append(event);
    const now = event.at;
    if (event.event === 'start' && record.state === 'STARTING') {
      this.store.transition(
        record,
        'RUNNING',
        {
          host: event.host,
          host_native_handle: event.host_handle,
          started_at: now,
          last_heartbeat_at: now,
          last_progress_at: now,
        },
        { native_event: event.event, host_handle: event.host_handle },
      );
    } else if (event.event === 'progress' && ['RUNNING', 'SUSPECT'].includes(record.state)) {
      this.store.patch(
        record,
        { last_heartbeat_at: now, last_progress_at: now },
        'native_progress',
        { detail: event.detail },
      );
    } else if (event.event === 'timeout' && ['STARTING', 'RUNNING', 'SUSPECT'].includes(record.state)) {
      this.store.transition(
        record,
        'CANCELLING',
        { cancel_requested_at: now, last_error: event.detail ?? 'Native task timed out.' },
        { native_event: event.event },
      );
    } else if (event.event === 'cancelled' && record.state === 'CANCELLING') {
      this.store.transition(
        record,
        'CANCELLED',
        {
          cancel_acknowledged_at: now,
          finished_at: now,
          revoked_leases: [...new Set([...record.revoked_leases, record.lease_id])],
        },
        { native_event: event.event, termination_confirmed: true },
      );
    } else if (event.event === 'cancel-unavailable' && record.state === 'CANCELLING') {
      this.store.transition(
        record,
        'ORPHANED',
        {
          finished_at: now,
          last_error: event.detail ?? 'The host cannot cancel this native task.',
          workspace_id: null,
          revoked_leases: [...new Set([...record.revoked_leases, record.lease_id])],
        },
        { native_event: event.event, termination_confirmed: false },
      );
    } else if (event.event === 'failure' && ['STARTING', 'RUNNING', 'SUSPECT'].includes(record.state)) {
      this.store.transition(
        record,
        'FAILED',
        { finished_at: now, last_error: event.detail ?? 'The native task failed.' },
        { native_event: event.event },
      );
    } else if (event.event === 'complete' && ['RUNNING', 'SUSPECT'].includes(record.state)) {
      this.store.transition(
        record,
        'AWAITING_NATIVE_RESULT',
        {
          finished_at: null,
          last_error: 'The native host completed the task. The deterministic core must validate its result bundle.',
        },
        { native_event: event.event, result_validation_pending: true },
      );
    }
    return event;
  }

  read(): NativeLifecycleEvent[] {
    if (!fs.existsSync(this.eventsFile)) return [];
    const events: NativeLifecycleEvent[] = [];
    for (const line of fs.readFileSync(this.eventsFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = NativeLifecycleEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) events.push(parsed.data);
      } catch {
        // Ignore a torn trailing event. Portable task projections remain authoritative.
      }
    }
    return events;
  }

  private append(event: NativeLifecycleEvent): void {
    ensureDir(path.dirname(this.eventsFile));
    appendLine(this.eventsFile, JSON.stringify(event));
  }
}
