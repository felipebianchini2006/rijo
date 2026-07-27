export const ENGINE_SUPERVISOR_STATES = [
  'STARTING',
  'RUNNING',
  'SUSPECT',
  'CANCELLING',
  'TERMINATING',
  'RESTARTING',
  'READY',
  'NOT_READY',
  'BLOCKED',
  'EXHAUSTED',
] as const;

export type EngineSupervisorState = (typeof ENGINE_SUPERVISOR_STATES)[number];
export type EngineRunStatus = 'READY' | 'NOT_READY' | 'BLOCKED';

export interface EngineProgress {
  sequence: number;
  observed_at: string;
}

export interface EngineSupervisorReceipt {
  receipt_id: string;
  owner_id: string;
  type:
    | 'supervisor.started'
    | 'supervisor.heartbeat'
    | 'supervisor.lock_denied'
    | 'engine.started'
    | 'engine.heartbeat'
    | 'engine.suspect'
    | 'engine.cancel_requested'
    | 'engine.terminating'
    | 'engine.terminated'
    | 'engine.fenced'
    | 'engine.reconciled'
    | 'engine.restarting'
    | 'supervisor.terminal'
    | 'supervisor.exhausted';
  state: EngineSupervisorState;
  generation: number;
  supervisor_pid: number;
  pid: number | null;
  process_group: number | null;
  created_at: string;
  reason?: string;
  data?: Record<string, unknown>;
}

/**
 * Persistence boundary owned by the Durable State Engine. The deterministic
 * process supervisor never imports SQLite or issues SQL; it only records
 * receipts and requests generation fencing/reconciliation through this port.
 */
export interface EngineSupervisorLedger {
  acquireSupervisorLease(ownerId: string, pid: number): Promise<boolean>;
  releaseSupervisorLease(ownerId: string): Promise<void>;
  readRunStatus(): Promise<EngineRunStatus | null>;
  readProgress(): Promise<EngineProgress>;
  readLastEngineGeneration(): Promise<number>;
  appendSupervisorReceipt(receipt: EngineSupervisorReceipt): Promise<void>;
  /** Persist supervisor exhaustion as the run's resumable terminal state. */
  markRunBlocked?(reason: string): Promise<void>;
  /** Terminate a process tree left by a previous supervisor instance. */
  terminateEngineGeneration?(
    generation: number,
  ): Promise<{ engine_tree_gone: boolean; detail?: string }>;
  fenceEngineGeneration(generation: number, reason: string): Promise<void>;
  /**
   * Reconcile orphan attempts, leases and workspaces and prove whether the
   * prior engine process tree is gone. A false result forbids replacement.
   */
  reconcileEngineGeneration(generation: number): Promise<{ engine_tree_gone: boolean; detail?: string }>;
}

export interface EngineExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface EngineStartContext {
  generation: number;
  owner_id: string;
}

export interface EngineProcessHandle {
  readonly pid: number | null;
  readonly process_group: number | null;
  readonly result: Promise<EngineExit>;
  isAlive(): boolean;
  /**
   * Terminate the whole process tree and return true only when the tree is
   * proven gone. Implementations must never report parent-only termination.
   */
  terminate(mode: 'term' | 'kill'): Promise<boolean>;
}

export interface EngineProcessFactory {
  start(context: EngineStartContext): Promise<EngineProcessHandle>;
}

export interface EngineSupervisorConfig {
  poll_interval_ms: number;
  no_progress_timeout_ms: number;
  hard_deadline_ms: number;
  cancel_grace_ms: number;
  kill_grace_ms: number;
  max_restarts: number;
}

export interface EngineSupervisorResult {
  status: EngineRunStatus;
  state: EngineSupervisorState;
  generation: number;
  restarts: number;
  reason: string;
}
