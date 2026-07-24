/**
 * Deterministic task supervision. Guarantees that no agent attempt can block a
 * workflow indefinitely: liveness comes only from the host controller, every
 * wait is bounded by an injectable Clock and an AbortSignal, only the current
 * generation holding the current unrevoked lease can produce an applicable
 * result, state is persisted before agents start, restart reconciles, and an
 * exhausted budget yields an actionable BLOCKED result instead of an infinite
 * loop.
 */
export { SystemClock, FakeClock, flushMicrotasks, type Clock, type TimerHandle } from './clock.js';
export { TaskStore, type TaskEvent } from './store.js';
export {
  Supervisor,
  type SuperviseOptions,
  type PreparedAttempt,
} from './supervisor.js';
export {
  reconcileSupervisedTasks,
  type ReconcileOptions,
  type ControllerLookup,
  type RecoveryReport,
  type RecoveryEntry,
  type RecoveryAction,
} from './recover.js';
export { InProcessController } from './runnerController.js';
export {
  ProcessController,
  type ProcessControllerOptions,
  type ProcessLaunch,
  type RawExit,
} from './processController.js';
export {
  killProcessTree,
  processGroupAlive,
  type KillTreeOptions,
  type KillTreeResult,
} from './killTree.js';
