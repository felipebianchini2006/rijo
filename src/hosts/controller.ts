import type { AgentTask, AgentResult } from '../agents/protocol.js';

/**
 * Capability-explicit host control surface for supervised attempts. The
 * supervisor drives EVERYTHING through this interface: starting an attempt,
 * probing liveness (runtime/process/connection facts — never model output),
 * requesting cancellation, hard-terminating when the host supports it, and
 * disposing resources. A host without forceTerminate still gets fencing: the
 * old lease is revoked, its workspace invalidated, and nothing it returns can
 * ever be applied.
 */

export interface HostAttemptHandle {
  attempt_id: string;
  lease_id: string;
  generation: number;
  /** host-native identifiers when available (recorded in the task record) */
  host: string;
  session_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  process_id?: number | null;
  /** resolves with the attempt's result (or rejects on hard host failure) */
  result: Promise<AgentResult>;
}

export interface HostLiveness {
  alive: boolean;
  /** ms since the host last showed signs of life, if known */
  last_activity_ms?: number | null;
  detail?: string;
}

export interface CancelReceipt {
  requested: boolean;
  /** true only when the host CONFIRMED the cancellation (never assumed from the request being sent) */
  acknowledged: boolean;
  detail?: string;
}

export interface TerminationReceipt {
  terminated: boolean;
  method: 'sigterm' | 'sigkill' | 'interrupt' | 'not_supported';
  detail?: string;
}

export type HostAttemptStatusKind = 'running' | 'completed' | 'dead' | 'disconnected' | 'unknown';

export interface HostAttemptStatus {
  kind: HostAttemptStatusKind;
  detail?: string;
}

export interface SupervisedAgentTask {
  task: AgentTask;
  /** absolute deadline hint for the host (the supervisor enforces its own) */
  hard_deadline_at: string;
}

export interface HostAgentController {
  readonly host: string;
  start(task: SupervisedAgentTask, signal: AbortSignal): Promise<HostAttemptHandle>;
  heartbeat(handle: HostAttemptHandle): Promise<HostLiveness>;
  requestCancel(handle: HostAttemptHandle, reason: string): Promise<CancelReceipt>;
  /** hard kill, when the host supports one (process SIGKILL, turn interrupt…) */
  forceTerminate?(handle: HostAttemptHandle, reason: string): Promise<TerminationReceipt>;
  query(handle: HostAttemptHandle): Promise<HostAttemptStatus>;
  dispose(handle: HostAttemptHandle): Promise<void>;
}
