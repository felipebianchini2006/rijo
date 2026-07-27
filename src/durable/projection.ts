import type { RunRecord, StoredDomainEvent } from './types.js';

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function objectPayload(event: StoredDomainEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
}

export function projectRunEvent(
  current: RunRecord | null,
  event: StoredDomainEvent,
): RunRecord | null {
  const payload = objectPayload(event);
  if (event.event_type === 'run.created') {
    return {
      id: event.run_id,
      plan_hash: String(payload['plan_hash'] ?? ''),
      host: String(payload['host'] ?? 'unknown'),
      status:
        payload['status'] === 'CREATED' || payload['status'] === 'RUNNING'
          ? payload['status']
          : 'RUNNING',
      created_at: event.created_at,
      updated_at: event.created_at,
      started_commit: stringOrNull(payload['started_commit']),
      final_commit: null,
      active_milestone: stringOrNull(payload['active_milestone']),
      active_phase: stringOrNull(payload['active_phase']),
      active_task: stringOrNull(payload['active_task']),
      last_event_sequence: event.sequence,
      terminal_reason: null,
    };
  }
  if (!current || current.id !== event.run_id) return current;

  const next: RunRecord = {
    ...current,
    updated_at: event.created_at,
    last_event_sequence: event.sequence,
  };
  const snapshot =
    payload['snapshot'] && typeof payload['snapshot'] === 'object'
      ? payload['snapshot'] as Record<string, unknown>
      : null;
  if (snapshot) {
    const milestone =
      snapshot['milestone'] && typeof snapshot['milestone'] === 'object'
        ? snapshot['milestone'] as Record<string, unknown>
        : null;
    const phase =
      snapshot['phase'] && typeof snapshot['phase'] === 'object'
        ? snapshot['phase'] as Record<string, unknown>
        : null;
    const task =
      snapshot['task'] && typeof snapshot['task'] === 'object'
        ? snapshot['task'] as Record<string, unknown>
        : null;
    next.active_milestone = stringOrNull(milestone?.['id']);
    next.active_phase = stringOrNull(phase?.['id']);
    next.active_task = stringOrNull(task?.['id']);
  }
  if (event.event_type === 'run.resumed') next.status = 'RUNNING';
  if (event.event_type === 'run.ready') next.status = 'READY';
  if (event.event_type === 'run.not_ready') next.status = 'NOT_READY';
  if (event.event_type === 'run.blocked') next.status = 'BLOCKED';
  if (event.event_type.startsWith('run.')) {
    next.active_milestone =
      payload['active_milestone'] === undefined
        ? next.active_milestone
        : stringOrNull(payload['active_milestone']);
    next.active_phase =
      payload['active_phase'] === undefined ? next.active_phase : stringOrNull(payload['active_phase']);
    next.active_task =
      payload['active_task'] === undefined ? next.active_task : stringOrNull(payload['active_task']);
  }
  if (['run.ready', 'run.not_ready', 'run.blocked'].includes(event.event_type)) {
    next.final_commit = stringOrNull(payload['final_commit']);
    next.terminal_reason = stringOrNull(payload['terminal_reason']);
    next.active_task = null;
  }
  return next;
}
