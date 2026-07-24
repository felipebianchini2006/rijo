import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  acquireLock,
  LockError,
  DEFAULT_LOCK_TTL_MS,
  STALE_HEARTBEAT_TTL_MULTIPLIER,
  type LockInfo,
} from '../src/core/locks.js';
import { withLock, type WorkflowContext } from '../src/workflows/shared.js';
import { RijoPaths } from '../src/core/paths.js';
import { ProgressBus, silentSink } from '../src/core/progress.js';
import { defaultConfig } from '../src/core/config.js';
import { tmpProject, cleanup } from './helpers.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write a raw lock.json to disk, bypassing acquireLock, to simulate another holder. */
function writeRawLock(lockPath: string, info: LockInfo): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(info, null, 2), 'utf8');
}

describe('locks', () => {
  let root: string;
  let lockPath: string;

  beforeEach(() => {
    root = tmpProject();
    lockPath = path.join(root, 'runtime', 'lock.json');
  });

  afterEach(() => {
    cleanup(root);
  });

  it('acquire creates lock.json in the new renewable-lease format', () => {
    const now = () => new Date('2026-07-24T12:00:00.000Z');
    const handle = acquireLock(lockPath, 'run-1', now);

    expect(fs.existsSync(lockPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.run_id).toBe('run-1');
    expect(onDisk.pid).toBe(process.pid);
    expect(typeof onDisk.hostname).toBe('string');
    expect(typeof onDisk.lease_id).toBe('string');
    expect(onDisk.lease_id.length).toBeGreaterThan(0);
    expect(onDisk.acquired_at).toBe('2026-07-24T12:00:00.000Z');
    expect(onDisk.heartbeat_at).toBe('2026-07-24T12:00:00.000Z');
    expect(onDisk.expires_at).toBe(new Date(Date.parse(onDisk.acquired_at) + DEFAULT_LOCK_TTL_MS).toISOString());
    expect(onDisk.active_attempts).toEqual([]);

    expect(handle.info.run_id).toBe('run-1');
    expect(handle.info.lease_id).toBe(onDisk.lease_id);
    expect(handle.reclaimedAttempts).toEqual([]);
  });

  it('contention: a valid (non-expired) lock throws LockError without instructing manual deletion', () => {
    const now = () => new Date('2026-07-24T12:00:00.000Z');
    const holder: LockInfo = {
      run_id: 'other-run',
      pid: process.pid, // alive
      hostname: 'testhost',
      lease_id: 'lease-other',
      acquired_at: '2026-07-24T11:59:00.000Z',
      heartbeat_at: '2026-07-24T11:59:30.000Z', // fresh, well under stale window
      expires_at: '2026-07-24T12:01:00.000Z', // not yet expired
      active_attempts: [],
    };
    writeRawLock(lockPath, holder);

    expect(() => acquireLock(lockPath, 'my-run', now)).toThrow(LockError);
    try {
      acquireLock(lockPath, 'my-run', now);
      expect.unreachable('acquireLock should have thrown');
    } catch (err) {
      const lockErr = err as LockError;
      expect(lockErr.holder.run_id).toBe('other-run');
      // Must never instruct the user to manually delete the lock file.
      expect(lockErr.message).not.toMatch(/delete/i);
      expect(lockErr.message).not.toMatch(/manually/i);
      expect(lockErr.message).not.toMatch(/apagar/i);
      // Must communicate automatic recycling with a concrete remaining time.
      expect(lockErr.message).toMatch(/expires in \d+s/i);
      expect(lockErr.message).toMatch(/automatically/i);
    }
    // holder's lock is untouched
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.run_id).toBe('other-run');
    expect(onDisk.lease_id).toBe('lease-other');
  });

  it('an expired lease is reconciled and taken over, returning the prior active_attempts as reclaimedAttempts', () => {
    const holder: LockInfo = {
      run_id: 'dead-run',
      pid: process.pid,
      hostname: 'testhost',
      lease_id: 'lease-dead',
      acquired_at: '2026-07-24T10:00:00.000Z',
      heartbeat_at: '2026-07-24T10:01:00.000Z',
      expires_at: '2026-07-24T10:02:00.000Z', // in the past relative to `now` below
      active_attempts: ['attempt-1', 'attempt-2'],
    };
    writeRawLock(lockPath, holder);

    const now = () => new Date('2026-07-24T10:05:00.000Z'); // after expiry
    const handle = acquireLock(lockPath, 'fresh-run', now);

    expect(handle.info.run_id).toBe('fresh-run');
    expect(handle.reclaimedAttempts).toEqual(['attempt-1', 'attempt-2']);
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.run_id).toBe('fresh-run');
    expect(onDisk.lease_id).not.toBe('lease-dead');
    expect(onDisk.active_attempts).toEqual([]); // new lease starts clean
  });

  it('does not reconcile a lease that has not yet expired and is not heartbeat-stale', () => {
    const holder: LockInfo = {
      run_id: 'other-run',
      pid: process.pid,
      hostname: 'testhost',
      lease_id: 'lease-other',
      acquired_at: '2026-07-24T10:00:00.000Z',
      heartbeat_at: '2026-07-24T10:01:29.000Z',
      expires_at: '2026-07-24T10:02:00.000Z',
      active_attempts: [],
    };
    writeRawLock(lockPath, holder);

    const now = () => new Date('2026-07-24T10:01:59.000Z'); // 1s before expiry
    expect(() => acquireLock(lockPath, 'my-run', now)).toThrow(LockError);
  });

  it('a live pid whose heartbeat is stale beyond 3xTTL is reconciled even though the lease has not formally expired', () => {
    const ttlMs = DEFAULT_LOCK_TTL_MS;
    const acquiredAt = new Date('2026-07-24T09:00:00.000Z');
    const staleHeartbeat = new Date(acquiredAt.getTime()); // never renewed since acquisition
    const now = () => new Date(staleHeartbeat.getTime() + STALE_HEARTBEAT_TTL_MULTIPLIER * ttlMs + 1000);
    const holder: LockInfo = {
      run_id: 'wedged-run',
      pid: process.pid, // alive
      hostname: 'testhost',
      lease_id: 'lease-wedged',
      acquired_at: acquiredAt.toISOString(),
      heartbeat_at: staleHeartbeat.toISOString(),
      // expires_at deliberately far in the future so this case is isolated
      // from the "expired" reconciliation path — the pid is alive and the
      // formal lease hasn't lapsed, but it has stopped renewing.
      expires_at: new Date(now().getTime() + 60 * 60 * 1000).toISOString(),
      active_attempts: ['orphan-1'],
    };
    writeRawLock(lockPath, holder);

    const handle = acquireLock(lockPath, 'fresh-run', now, { ttlMs });
    expect(handle.info.run_id).toBe('fresh-run');
    expect(handle.reclaimedAttempts).toEqual(['orphan-1']);
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.run_id).toBe('fresh-run');
  });

  it('renew() advances heartbeat_at and expires_at using the injected clock', () => {
    let t = Date.parse('2026-07-24T12:00:00.000Z');
    const now = () => new Date(t);
    const ttlMs = 90_000;
    const handle = acquireLock(lockPath, 'run-1', now, { ttlMs });
    const initialExpires = handle.info.expires_at;

    t += 30_000; // advance clock 30s
    handle.renew();

    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.heartbeat_at).toBe(new Date(t).toISOString());
    expect(onDisk.expires_at).toBe(new Date(t + ttlMs).toISOString());
    expect(onDisk.expires_at).not.toBe(initialExpires);
    expect(Date.parse(onDisk.expires_at)).toBeGreaterThan(Date.parse(initialExpires));
  });

  it('registerAttempt/releaseAttempt persist active_attempts to disk and stay idempotent', () => {
    const handle = acquireLock(lockPath, 'run-1', () => new Date('2026-07-24T12:00:00.000Z'));

    handle.registerAttempt('a1');
    handle.registerAttempt('a2');
    handle.registerAttempt('a1'); // idempotent, no duplicate
    let onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.active_attempts).toEqual(['a1', 'a2']);
    expect(handle.info.active_attempts).toEqual(['a1', 'a2']);

    handle.releaseAttempt('a1');
    handle.releaseAttempt('does-not-exist'); // no-op
    onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.active_attempts).toEqual(['a2']);
  });

  it('release() with active attempts requires force=true and returns the orphaned attempt ids', () => {
    const handle = acquireLock(lockPath, 'run-1', () => new Date('2026-07-24T12:00:00.000Z'));
    handle.registerAttempt('a1');
    handle.registerAttempt('a2');

    expect(() => handle.release()).toThrow(/force/i);
    expect(fs.existsSync(lockPath)).toBe(true); // refused release leaves the lock intact

    const result = handle.release(true);
    expect(result.orphanedAttempts).toEqual(['a1', 'a2']);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release() with no active attempts succeeds without force and returns no orphans', () => {
    const handle = acquireLock(lockPath, 'run-1', () => new Date('2026-07-24T12:00:00.000Z'));
    const result = handle.release();
    expect(result.orphanedAttempts).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release() is a no-op when the on-disk lease_id no longer matches (already reclaimed by someone else)', () => {
    const handle = acquireLock(lockPath, 'run-1', () => new Date('2026-07-24T12:00:00.000Z'));

    // Someone else reconciled and took over the lock in the meantime.
    const usurper: LockInfo = {
      run_id: 'usurper-run',
      pid: process.pid,
      hostname: 'testhost',
      lease_id: 'lease-usurper',
      acquired_at: '2026-07-24T13:00:00.000Z',
      heartbeat_at: '2026-07-24T13:00:00.000Z',
      expires_at: '2026-07-24T13:01:30.000Z',
      active_attempts: [],
    };
    writeRawLock(lockPath, usurper);

    const result = handle.release();
    expect(result.orphanedAttempts).toEqual([]);
    // the usurper's lock is untouched
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.lease_id).toBe('lease-usurper');
  });
});

describe('withLock', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject();
  });

  afterEach(() => {
    cleanup(root);
  });

  function makeCtx(): WorkflowContext {
    const paths = new RijoPaths(root);
    const now = () => new Date(); // real clock: withLock's renewal timers are real too
    const bus = new ProgressBus(paths, 'test-run', silentSink, now);
    // config is required: withLock reads config.supervisor for startup recovery.
    return { paths, bus, now, config: defaultConfig() } as unknown as WorkflowContext;
  }

  it('renews the lease in the background so a long-running body never sees it expire', async () => {
    const ctx = makeCtx();
    const ttlMs = 150;
    const renewMs = 40;
    const lockPath = ctx.paths.lock;

    let sawUnexpired = false;
    await withLock(
      ctx,
      async () => {
        // Wait well past the raw TTL — only the background renewal can keep the lease alive.
        await sleep(ttlMs * 4);
        const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
        sawUnexpired = Date.parse(onDisk.expires_at) > Date.now();
        return null;
      },
      { ttlMs, renewMs },
    );

    expect(sawUnexpired).toBe(true);
    // released cleanly at the end
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('emits lock.reclaimed with the orphaned attempt ids when taking over an expired lease', async () => {
    const ctx = makeCtx();
    const lockPath = ctx.paths.lock;
    const staleHolder: LockInfo = {
      run_id: 'dead-run',
      pid: process.pid,
      hostname: 'testhost',
      lease_id: 'lease-dead',
      acquired_at: '2000-01-01T00:00:00.000Z',
      heartbeat_at: '2000-01-01T00:00:00.000Z',
      expires_at: '2000-01-01T00:00:01.000Z', // long expired
      active_attempts: ['orphan-x'],
    };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(staleHolder, null, 2), 'utf8');

    const events: unknown[] = [];
    const originalEmit = ctx.bus.emit.bind(ctx.bus);
    ctx.bus.emit = ((type: string, update?: unknown, data?: unknown) => {
      if (type === 'lock.reclaimed') events.push(data);
      return originalEmit(type, update as never, data as never);
    }) as typeof ctx.bus.emit;

    await withLock(ctx, async () => null);

    expect(events).toEqual([{ attempts: ['orphan-x'] }]);
  });
});
