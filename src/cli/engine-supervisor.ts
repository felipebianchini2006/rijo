#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EngineSupervisor,
  NodeEngineProcessFactory,
  type EngineRunStatus,
  type EngineSupervisorConfig,
  type EngineSupervisorLedger,
  type EngineSupervisorResult,
} from '../supervisor/engineSupervisor.js';

export interface RunEngineSupervisorOptions {
  projectRoot: string;
  args: string[];
  ledger: EngineSupervisorLedger;
  config: EngineSupervisorConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Injectable parent entrypoint. CLI routing supplies the durable ledger port;
 * this module deliberately has no SQLite knowledge and never creates a run.
 */
export async function runEngineSupervisor(options: RunEngineSupervisorOptions): Promise<EngineSupervisorResult> {
  const engineEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine.js');
  const factory = new NodeEngineProcessFactory({
    command: process.execPath,
    args: [engineEntry, ...options.args],
    cwd: options.projectRoot,
    env: options.env,
    stdio: 'inherit',
    termination_timeout_ms: Math.max(options.config.cancel_grace_ms, options.config.kill_grace_ms),
  });
  return new EngineSupervisor({
    ledger: options.ledger,
    processFactory: factory,
    config: options.config,
  }).run();
}

export function engineSupervisorExitCode(status: EngineRunStatus): number {
  if (status === 'READY') return 0;
  if (status === 'NOT_READY') return 1;
  return 3;
}
