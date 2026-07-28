import { DurableStateEngine } from './engine.js';
import {
  recoverSqliteState,
} from './recovery.js';
import {
  SqliteDriverLoadError,
  type SqliteStateStoreOptions,
} from './sqliteStore.js';
import { FileStateStore } from './fileStore.js';
import { DurableOutboxProjector } from './projector.js';
import {
  DurableWorkflowEngine,
  type WorkflowRecoveryResult,
} from './workflowAdapter.js';

export interface OpenDurableStateEngineResult {
  engine: DurableStateEngine;
  recovery: WorkflowRecoveryResult;
}

export interface DurableStateEngineOptions extends SqliteStateStoreOptions {
  stateStore?: 'auto' | 'sqlite' | 'file';
}

export async function recoverDurableState(
  options: DurableStateEngineOptions,
): Promise<WorkflowRecoveryResult> {
  const selected = options.stateStore ?? 'auto';
  if (selected !== 'file') {
    try {
      return await recoverSqliteState(options);
    } catch (error) {
      if (selected === 'sqlite' || !(error instanceof SqliteDriverLoadError)) throw error;
    }
  }
  const store = new FileStateStore({ projectRoot: options.projectRoot });
  await store.initialize();
  const projected = await new DurableOutboxProjector(options.projectRoot, store).flush();
  return {
    store,
    rebuilt: true,
    projected,
    diagnostic_database: null,
  };
}

export async function openDurableStateEngine(
  options: DurableStateEngineOptions,
): Promise<OpenDurableStateEngineResult> {
  const recovery = await recoverDurableState(options);
  return {
    engine: new DurableStateEngine(options.projectRoot, recovery.store, options.now),
    recovery,
  };
}

export async function openDurableWorkflowEngine(
  projectRoot: string,
  options: Omit<DurableStateEngineOptions, 'projectRoot'> = {},
): Promise<DurableWorkflowEngine> {
  const recovery = await recoverDurableState({ projectRoot, ...options });
  return new DurableWorkflowEngine(
    projectRoot,
    new DurableStateEngine(projectRoot, recovery.store, options.now),
    recovery,
    options.now,
  );
}
