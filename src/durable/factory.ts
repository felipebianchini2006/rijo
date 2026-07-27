import { DurableStateEngine } from './engine.js';
import {
  recoverSqliteState,
  type DurableRecoveryResult,
} from './recovery.js';
import type { SqliteStateStoreOptions } from './sqliteStore.js';
import { DurableWorkflowEngine } from './workflowAdapter.js';

export interface OpenDurableStateEngineResult {
  engine: DurableStateEngine;
  recovery: DurableRecoveryResult;
}

export async function openDurableStateEngine(
  options: SqliteStateStoreOptions,
): Promise<OpenDurableStateEngineResult> {
  const recovery = await recoverSqliteState(options);
  return {
    engine: new DurableStateEngine(options.projectRoot, recovery.store, options.now),
    recovery,
  };
}

export async function openDurableWorkflowEngine(
  projectRoot: string,
  options: Omit<SqliteStateStoreOptions, 'projectRoot'> = {},
): Promise<DurableWorkflowEngine> {
  const recovery = await recoverSqliteState({ projectRoot, ...options });
  return new DurableWorkflowEngine(
    projectRoot,
    new DurableStateEngine(projectRoot, recovery.store, options.now),
    recovery,
    options.now,
  );
}
