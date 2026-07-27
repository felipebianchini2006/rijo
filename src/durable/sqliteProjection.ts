import type BetterSqlite3 from 'better-sqlite3';
import { canonicalJson, sha256 } from './canonical.js';
import type { StoredDomainEvent } from './types.js';

type Database = BetterSqlite3.Database;

export function projectWorkflowState(db: Database, event: StoredDomainEvent): void {
  const payload = event.payload as Record<string, unknown>;
  const data =
    payload['data'] && typeof payload['data'] === 'object'
      ? payload['data'] as Record<string, unknown>
      : {};
  if (event.event_type === 'decision.approved') {
    const proposal =
      data['proposal'] && typeof data['proposal'] === 'object'
        ? data['proposal'] as Record<string, unknown>
        : {};
    const id = String(proposal['id'] ?? event.event_id);
    const contentHash = sha256(canonicalJson(proposal));
    db.prepare(
      `INSERT OR IGNORE INTO decisions (
         id, run_id, attempt_id, generation, status, payload, content_hash,
         idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'APPROVED', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      event.run_id,
      nullableString(data['attempt_id']),
      Number(data['generation'] ?? 1),
      canonicalJson(proposal),
      contentHash,
      event.idempotency_key,
      event.created_at,
      event.created_at,
    );
  }
  if (event.event_type === 'run.verify_command' || event.event_type === 'check.command') {
    const command = String(data['command'] ?? '');
    if (command) {
      db.prepare(
        `INSERT OR IGNORE INTO command_evidence (
           id, run_id, logical_task_id, command_hash, classification, exit_code,
           receipt, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, 'SAFE_REPEATABLE', ?, ?, ?, ?)`,
      ).run(
        `command-${event.event_hash}`,
        event.run_id,
        nullableString(data['task']),
        sha256(command),
        Number(data['exit'] ?? -1),
        canonicalJson(data),
        event.idempotency_key,
        event.created_at,
      );
    }
  }
  if (event.event_type !== 'state.synchronized') return;
  const packet = payload['projection'] as Record<string, unknown> | undefined;
  if (!packet) return;
  const now = event.created_at;
  const milestone = packet['milestone'] as Record<string, unknown> | null;
  if (!milestone || typeof milestone['id'] !== 'string') return;
  const milestoneId = milestone['id'];
  db.prepare(
    `INSERT INTO milestones (id, run_id, status, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload,
       updated_at=excluded.updated_at`,
  ).run(
    milestoneId,
    event.run_id,
    String(milestone['status'] ?? 'ACTIVE'),
    canonicalJson(milestone),
    now,
    now,
  );

  for (const phase of arrayOfRecords(packet['phases'])) {
    const id = String(phase['id'] ?? '');
    if (!id) continue;
    db.prepare(
      `INSERT INTO phases (id, milestone_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(milestone_id, id) DO UPDATE SET status=excluded.status,
         payload=excluded.payload, updated_at=excluded.updated_at`,
    ).run(id, milestoneId, String(phase['status'] ?? 'PENDING'), canonicalJson(phase), now, now);
  }

  for (const requirement of arrayOfRecords(packet['requirements'])) {
    const id = String(requirement['id'] ?? '');
    if (!id) continue;
    db.prepare(
      `INSERT INTO requirements (id, milestone_id, phase_id, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET phase_id=excluded.phase_id, status=excluded.status,
         payload=excluded.payload, updated_at=excluded.updated_at`,
    ).run(
      id,
      milestoneId,
      nullableString(requirement['phase']),
      String(requirement['status'] ?? 'PENDING'),
      canonicalJson(requirement),
      now,
      now,
    );
  }

  for (const task of arrayOfRecords(packet['tasks'])) {
    upsertTask(db, event, milestoneId, task, now);
  }
  for (const attempt of arrayOfRecords(packet['attempts'])) {
    const logicalTaskId = String(attempt['logical_task_id'] ?? '');
    const attemptId = String(attempt['attempt_id'] ?? '');
    const leaseId = String(attempt['lease_id'] ?? '');
    if (!logicalTaskId || !attemptId || !leaseId) continue;
    const existingAttempt = db
      .prepare('SELECT generation FROM agent_attempts WHERE attempt_id = ?')
      .get(attemptId) as { generation: number } | undefined;
    const previousGeneration = db
      .prepare(
        'SELECT COALESCE(MAX(generation), 0) AS generation FROM agent_attempts WHERE logical_task_id = ?',
      )
      .get(logicalTaskId) as { generation: number };
    const requestedGeneration = Number(attempt['generation'] ?? 1);
    const durableGeneration =
      existingAttempt?.generation ??
      Math.max(requestedGeneration, previousGeneration.generation + 1);
    upsertTask(db, event, milestoneId, {
      logical_task_id: logicalTaskId,
      phase_id: inferPhase(logicalTaskId),
      status: attempt['state'],
      generation: durableGeneration,
      replacement_count: attempt['replacement_count'],
      idempotency_key: attempt['idempotency_key'],
      write_scope: [],
    }, now);
    db.prepare(
      `INSERT INTO agent_attempts (
         attempt_id, logical_task_id, generation, lease_id, workspace_id, host, model,
         state, pid, process_group, started_at, last_heartbeat, last_progress,
         soft_deadline, hard_deadline, finished_at, result_hash,
         cancellation_receipt, termination_receipt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(attempt_id) DO UPDATE SET state=excluded.state,
         last_heartbeat=excluded.last_heartbeat, last_progress=excluded.last_progress,
         finished_at=excluded.finished_at`,
    ).run(
      attemptId,
      logicalTaskId,
      durableGeneration,
      leaseId,
      nullableString(attempt['workspace_id']),
      String(attempt['host'] ?? 'unknown'),
      null,
      String(attempt['state'] ?? 'QUEUED'),
      attempt['host_process_id'] ?? null,
      null,
      String(attempt['started_at'] ?? attempt['created_at'] ?? now),
      nullableString(attempt['last_heartbeat_at']),
      nullableString(attempt['last_progress_at']),
      nullableString(attempt['soft_deadline_at']),
      nullableString(attempt['hard_deadline_at']),
      nullableString(attempt['finished_at']),
      null,
      null,
      null,
    );
  }

  const mapState = packet['map_state'] as Record<string, unknown> | null;
  if (mapState && typeof mapState === 'object') {
    const mappedCommit = String(mapState['mapped_commit'] ?? '');
    const treeHash = String(mapState['mapped_tree_hash'] ?? mapState['tree_hash'] ?? '');
    if (mappedCommit && treeHash) {
      const contentHash = sha256(canonicalJson(mapState));
      db.prepare(
        `INSERT OR IGNORE INTO map_versions (
           id, run_id, mapped_commit, tree_hash, context_packet_hash, status,
           payload, created_at, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `map-${contentHash}`,
        event.run_id,
        mappedCommit,
        treeHash,
        nullableString(mapState['context_packet_hash']),
        String(mapState['status'] ?? 'PARTIAL'),
        canonicalJson(mapState),
        now,
        contentHash,
      );
    }
  }
}

function upsertTask(
  db: Database,
  event: StoredDomainEvent,
  milestoneId: string,
  task: Record<string, unknown>,
  now: string,
): void {
  const logicalTaskId = String(task['logical_task_id'] ?? '');
  if (!logicalTaskId) return;
  const stable = sha256(canonicalJson({ run: event.run_id, logicalTaskId }));
  db.prepare(
    `INSERT INTO tasks (
       logical_task_id, milestone_id, phase_id, status, generation,
       replacement_count, idempotency_key, write_scope, acceptance_hash,
       verification_hash, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(logical_task_id) DO UPDATE SET status=excluded.status,
       generation=excluded.generation, replacement_count=excluded.replacement_count,
       write_scope=excluded.write_scope, updated_at=excluded.updated_at`,
  ).run(
    logicalTaskId,
    milestoneId,
    String(task['phase_id'] ?? inferPhase(logicalTaskId)),
    String(task['status'] ?? 'PENDING'),
    Number(task['generation'] ?? 1),
    Number(task['replacement_count'] ?? 0),
    String(task['idempotency_key'] ?? stable),
    canonicalJson(task['write_scope'] ?? []),
    sha256(canonicalJson(task['acceptance_criteria'] ?? task['evidence_expected'] ?? null)),
    sha256(canonicalJson(task['tests'] ?? null)),
    now,
    now,
  );
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function inferPhase(logicalTaskId: string): string {
  return logicalTaskId.match(/(?:^|[-:])(\d{2})(?:[-:]|$)/)?.[1] ?? '00';
}
