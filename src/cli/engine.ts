#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { runCli } from './main.js';
import { runEngine } from '../engine/run.js';
import { RijoPaths } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { openEngineSupervisorLedger } from '../durable/index.js';

runWithHeartbeat().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`rijo-engine: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);

async function runWithHeartbeat(): Promise<number> {
  const cwd = process.cwd();
  const ledger = await openEngineSupervisorLedger(cwd, { mode: 'run' });
  const generation = Number(process.env['RIJO_ENGINE_GENERATION'] ?? 0);
  const ownerId = process.env['RIJO_SUPERVISOR_OWNER_ID'] ?? `orphan-${process.pid}`;
  const intervalMs = Math.max(
    250,
    loadConfig(new RijoPaths(cwd)).engine_supervisor.poll_interval_ms,
  );
  const beat = async (): Promise<void> => {
    const createdAt = new Date().toISOString();
    await ledger.appendSupervisorReceipt({
      receipt_id: randomUUID(),
      owner_id: ownerId,
      type: 'engine.heartbeat',
      state: 'RUNNING',
      generation,
      supervisor_pid: process.ppid,
      pid: process.pid,
      process_group: process.platform === 'win32' ? null : process.pid,
      created_at: createdAt,
    });
  };
  await beat();
  const timer = setInterval(() => {
    void beat().catch(() => {
      // The parent also observes process liveness; a failed durable heartbeat
      // must not turn into an unhandled rejection inside the engine.
    });
  }, intervalMs);
  timer.unref();
  try {
    return await runEngine(process.argv.slice(2), runCli);
  } finally {
    clearInterval(timer);
    await ledger.close();
  }
}
