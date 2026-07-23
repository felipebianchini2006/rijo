import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonIfExists, ensureDir } from './fsx.js';

export interface LockInfo {
  pid: number;
  run_id: string;
  acquired_at: string;
  hostname: string;
}

export class LockError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(
      `Another RIJO run holds the lock (run ${holder.run_id}, pid ${holder.pid}, since ${holder.acquired_at}). ` +
        `If that run is dead, delete .rijo/runtime/lock.json and retry.`,
    );
    this.name = 'LockError';
  }
}

const STALE_MS = 1000 * 60 * 60 * 6; // 6h: a run silent this long is considered dead

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Acquire the run lock via exclusive file create; throws LockError if held. */
export function acquireLock(lockPath: string, runId: string, now: () => Date = () => new Date()): LockInfo {
  ensureDir(path.dirname(lockPath));
  const existing = readJsonIfExists<LockInfo>(lockPath);
  if (existing) {
    const age = now().getTime() - Date.parse(existing.acquired_at);
    const stale = !pidAlive(existing.pid) || age > STALE_MS;
    if (!stale) throw new LockError(existing);
    fs.rmSync(lockPath, { force: true });
  }
  const info: LockInfo = {
    pid: process.pid,
    run_id: runId,
    acquired_at: now().toISOString(),
    hostname: process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? 'unknown',
  };
  // 'wx' fails if the file reappeared between the check and the write.
  fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), { flag: 'wx' });
  return info;
}

export function releaseLock(lockPath: string, runId: string): void {
  const existing = readJsonIfExists<LockInfo>(lockPath);
  if (existing && existing.run_id === runId) fs.rmSync(lockPath, { force: true });
}
