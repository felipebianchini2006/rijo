import { STATE_SCHEMA_VERSION } from './types.js';

export interface StateMigration {
  version: number;
  name: string;
  sql: string;
}

const INITIAL_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('CREATED','RUNNING','READY','NOT_READY','BLOCKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_commit TEXT,
  final_commit TEXT,
  active_milestone TEXT,
  active_phase TEXT,
  active_task TEXT,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  terminal_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active
  ON runs((1)) WHERE status IN ('CREATED','RUNNING');
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status, updated_at);
CREATE INDEX IF NOT EXISTS runs_plan_hash_idx ON runs(plan_hash);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, id)
);
CREATE INDEX IF NOT EXISTS milestones_run_status_idx ON milestones(run_id, status);

CREATE TABLE IF NOT EXISTS phases (
  id TEXT NOT NULL,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(milestone_id, id)
);
CREATE INDEX IF NOT EXISTS phases_milestone_status_idx ON phases(milestone_id, status);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  phase_id TEXT,
  status TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requirements_milestone_status_idx ON requirements(milestone_id, status);
CREATE INDEX IF NOT EXISTS requirements_phase_idx ON requirements(milestone_id, phase_id);

CREATE TABLE IF NOT EXISTS tasks (
  logical_task_id TEXT PRIMARY KEY,
  milestone_id TEXT NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1),
  replacement_count INTEGER NOT NULL DEFAULT 0 CHECK(replacement_count >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  write_scope TEXT NOT NULL DEFAULT '[]',
  acceptance_hash TEXT NOT NULL,
  verification_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_milestone_phase_status_idx ON tasks(milestone_id, phase_id, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(logical_task_id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(logical_task_id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, depends_on_task_id),
  CHECK(task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS agent_attempts (
  attempt_id TEXT PRIMARY KEY,
  logical_task_id TEXT NOT NULL REFERENCES tasks(logical_task_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  lease_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT,
  host TEXT NOT NULL,
  model TEXT,
  state TEXT NOT NULL,
  pid INTEGER,
  process_group INTEGER,
  started_at TEXT NOT NULL,
  last_heartbeat TEXT,
  last_progress TEXT,
  soft_deadline TEXT,
  hard_deadline TEXT,
  finished_at TEXT,
  result_hash TEXT,
  cancellation_receipt TEXT,
  termination_receipt TEXT,
  UNIQUE(logical_task_id, generation)
);
CREATE INDEX IF NOT EXISTS attempts_task_state_idx ON agent_attempts(logical_task_id, state);
CREATE INDEX IF NOT EXISTS attempts_state_heartbeat_idx ON agent_attempts(state, last_heartbeat);

CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  logical_task_id TEXT REFERENCES tasks(logical_task_id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES agent_attempts(attempt_id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED','EXPIRED')),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  fenced_at TEXT,
  fence_reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS leases_run_state_idx ON leases(run_id, state);
CREATE INDEX IF NOT EXISTS leases_attempt_state_idx ON leases(attempt_id, state);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  attempt_id TEXT,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_run_status_idx ON decisions(run_id, status);

CREATE TABLE IF NOT EXISTS decision_evidence (
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(decision_id, ordinal)
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  previous_event_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(run_id, sequence);
CREATE INDEX IF NOT EXISTS events_aggregate_idx ON events(aggregate_type, aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS events_type_idx ON events(event_type, sequence);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  event_sequence INTEGER NOT NULL,
  projection_type TEXT NOT NULL,
  destination TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','PROJECTED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  projected_at TEXT,
  UNIQUE(event_sequence, projection_type, destination)
);
CREATE INDEX IF NOT EXISTS outbox_status_sequence_idx ON outbox(status, event_sequence);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  event_sequence INTEGER REFERENCES events(sequence),
  created_at TEXT NOT NULL,
  UNIQUE(run_id, path, content_hash)
);

CREATE TABLE IF NOT EXISTS artifact_hashes (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY(artifact_id, algorithm)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  git_commit TEXT,
  tree_hash TEXT,
  snapshot_hash TEXT,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS checkpoints_run_sequence_idx ON checkpoints(run_id, event_sequence);

CREATE TABLE IF NOT EXISTS command_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  logical_task_id TEXT,
  command_hash TEXT NOT NULL,
  classification TEXT NOT NULL,
  exit_code INTEGER,
  receipt TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS command_evidence_run_idx ON command_evidence(run_id, created_at);

CREATE TABLE IF NOT EXISTS map_versions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  mapped_commit TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  context_packet_hash TEXT,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS map_versions_run_created_idx ON map_versions(run_id, created_at);

CREATE TABLE IF NOT EXISTS locks (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  process_group INTEGER,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS process_receipts (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  process_type TEXT NOT NULL,
  pid INTEGER,
  process_group INTEGER,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS process_receipts_run_idx ON process_receipts(run_id, created_at);

CREATE TABLE IF NOT EXISTS recovery_receipts (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  recovery_type TEXT NOT NULL,
  source_hash TEXT,
  result_hash TEXT,
  payload TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recovery_receipts_run_idx ON recovery_receipts(run_id, created_at);
`;

export const STATE_MIGRATIONS: readonly StateMigration[] = [
  { version: 1, name: 'initial', sql: INITIAL_SQL.trim() },
  {
    version: 2,
    name: 'checkpoint-retention-index',
    sql: `
CREATE INDEX IF NOT EXISTS checkpoints_kind_sequence_idx
  ON checkpoints(kind, event_sequence);
`.trim(),
  },
];

if (STATE_MIGRATIONS.at(-1)?.version !== STATE_SCHEMA_VERSION) {
  throw new Error('State migration registry does not match STATE_SCHEMA_VERSION');
}
