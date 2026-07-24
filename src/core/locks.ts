import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonIfExists, ensureDir, writeJsonAtomic } from './fsx.js';

/** On-disk shape of .rijo/runtime/lock.json — a renewable lease, not a fixed hold. */
export interface LockInfo {
  run_id: string;
  pid: number;
  hostname: string;
  lease_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  active_attempts: string[];
}

/** Default lease length. A holder that stops renewing is reclaimable after this. */
export const DEFAULT_LOCK_TTL_MS = 90_000;
/** Recommended cadence for renew() calls — comfortably inside the TTL. */
export const RECOMMENDED_RENEW_MS = 30_000;
/** A live pid that hasn't renewed in this many TTLs is treated as wedged, not held. */
export const STALE_HEARTBEAT_TTL_MULTIPLIER = 3;

export class LockError extends Error {
  constructor(
    public readonly holder: LockInfo,
    nowMs: number,
  ) {
    const remainingS = Math.max(0, Math.round((Date.parse(holder.expires_at) - nowMs) / 1000));
    super(
      `Another RIJO run holds the lock (run ${holder.run_id}, pid ${holder.pid}, since ${holder.acquired_at}). ` +
        `Lease expires in ${remainingS}s and will be recycled automatically — no manual action needed.`,
    );
    this.name = 'LockError';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function hostname(): string {
  return process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? 'unknown';
}

/** A held lease: renew it, track in-flight attempts on it, and release it when done. */
export interface LockHandle {
  readonly info: LockInfo;
  /** Attempt ids reclaimed from a prior holder's lock during acquisition (orphaned by expiry/staleness). */
  readonly reclaimedAttempts: string[];
  /** Push heartbeat_at/expires_at forward by ttlMs from now. */
  renew(): void;
  /** Record an in-flight attempt id on the lock so a crash can be traced/fenced. */
  registerAttempt(id: string): void;
  /** Remove a completed/aborted attempt id from the lock. */
  releaseAttempt(id: string): void;
  /**
   * Release the lease. No-ops if this handle's lease_id no longer matches the
   * file on disk (already reclaimed by someone else). Refuses to release while
   * active_attempts is non-empty unless force=true, in which case it deletes
   * the lock anyway and returns those attempt ids so the caller can fence them.
   */
  release(force?: boolean): { orphanedAttempts: string[] };
}

/**
 * Acquire (or reconcile and take over) the run lock as a renewable lease.
 *
 * Reconciliation is never a blind delete:
 *  - expired lease (expires_at in the past): the prior holder's active_attempts
 *    are returned as reclaimedAttempts and the lease is taken over.
 *  - live pid but heartbeat_at stale beyond STALE_HEARTBEAT_TTL_MULTIPLIER*ttl:
 *    the process is alive but not renewing (wedged) — reconciled and taken over.
 *  - otherwise the lease is valid and LockError is thrown (never instructs
 *    manual deletion; the lease will recycle itself on expiry).
 */
export function acquireLock(
  lockPath: string,
  runId: string,
  now: () => Date = () => new Date(),
  opts: { ttlMs?: number } = {},
): LockHandle {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  ensureDir(path.dirname(lockPath));

  let reclaimedAttempts: string[] = [];
  const existing = readJsonIfExists<LockInfo>(lockPath);
  if (existing) {
    const nowMs = now().getTime();
    const expired = nowMs >= Date.parse(existing.expires_at);
    const heartbeatAge = nowMs - Date.parse(existing.heartbeat_at);
    const wedged = pidAlive(existing.pid) && heartbeatAge > STALE_HEARTBEAT_TTL_MULTIPLIER * ttlMs;
    if (!expired && !wedged) throw new LockError(existing, nowMs);
    reclaimedAttempts = existing.active_attempts ?? [];
    fs.rmSync(lockPath, { force: true });
  }

  const acquiredAt = now().toISOString();
  const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
  const info: LockInfo = {
    run_id: runId,
    pid: process.pid,
    hostname: hostname(),
    lease_id: randomUUID(),
    acquired_at: acquiredAt,
    heartbeat_at: acquiredAt,
    expires_at: expiresAt,
    active_attempts: [],
  };
  // 'wx' fails if the file reappeared between the reconciliation check and this write.
  fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), { flag: 'wx' });

  const persist = (next: LockInfo) => {
    info.heartbeat_at = next.heartbeat_at;
    info.expires_at = next.expires_at;
    info.active_attempts = next.active_attempts;
    writeJsonAtomic(lockPath, info);
  };

  return {
    info,
    reclaimedAttempts,
    renew(): void {
      const nowMs = now().getTime();
      persist({
        ...info,
        heartbeat_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + ttlMs).toISOString(),
      });
    },
    registerAttempt(id: string): void {
      if (info.active_attempts.includes(id)) return;
      persist({ ...info, active_attempts: [...info.active_attempts, id] });
    },
    releaseAttempt(id: string): void {
      if (!info.active_attempts.includes(id)) return;
      persist({ ...info, active_attempts: info.active_attempts.filter((a) => a !== id) });
    },
    release(force = false): { orphanedAttempts: string[] } {
      const onDisk = readJsonIfExists<LockInfo>(lockPath);
      if (!onDisk || onDisk.lease_id !== info.lease_id) return { orphanedAttempts: [] };
      if (onDisk.active_attempts.length > 0 && !force) {
        throw new Error(
          `Cannot release lock: ${onDisk.active_attempts.length} attempt(s) still active (${onDisk.active_attempts.join(', ')}). Pass force=true to release and fence them.`,
        );
      }
      const orphanedAttempts = onDisk.active_attempts;
      fs.rmSync(lockPath, { force: true });
      return { orphanedAttempts };
    },
  };
}
