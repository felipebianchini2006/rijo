import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { acquireLock, releaseLock, LockError, type LockInfo } from '../src/core/locks.js';
import { tmpProject, cleanup } from './helpers.js';

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

  it('acquire creates lock.json with holder info', () => {
    const info = acquireLock(lockPath, 'run-1');
    expect(fs.existsSync(lockPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.run_id).toBe('run-1');
    expect(onDisk.pid).toBe(process.pid);
    expect(info.run_id).toBe('run-1');
    expect(info.pid).toBe(process.pid);
  });

  it('second acquire throws LockError while the holder pid is alive and fresh', () => {
    // Simulate a live holder from a different run: this process's own pid
    // (pidAlive(process.pid) is true) with a fresh timestamp.
    const now = () => new Date('2026-07-23T12:00:00.000Z');
    const holder: LockInfo = {
      pid: process.pid,
      run_id: 'other-run',
      acquired_at: '2026-07-23T11:59:00.000Z',
      hostname: 'testhost',
    };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(holder), 'utf8');

    expect(() => acquireLock(lockPath, 'my-run', now)).toThrow(LockError);
    try {
      acquireLock(lockPath, 'my-run', now);
      expect.unreachable('acquireLock should have thrown');
    } catch (err) {
      expect((err as LockError).holder.run_id).toBe('other-run');
    }
    // holder's lock is untouched
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.run_id).toBe('other-run');
  });

  it('steals a stale lock older than 6h (via injected now)', () => {
    const holder: LockInfo = {
      pid: process.pid, // alive, but acquired_at is too old
      run_id: 'dead-run',
      acquired_at: '2026-07-23T00:00:00.000Z',
      hostname: 'testhost',
    };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(holder), 'utf8');

    const now = () => new Date('2026-07-23T07:00:00.001Z'); // 7h later > 6h stale window
    const info = acquireLock(lockPath, 'fresh-run', now);
    expect(info.run_id).toBe('fresh-run');
    expect(info.acquired_at).toBe('2026-07-23T07:00:00.001Z');
    const onDisk = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    expect(onDisk.run_id).toBe('fresh-run');
  });

  it('does not steal a live lock just under the stale window', () => {
    const holder: LockInfo = {
      pid: process.pid,
      run_id: 'other-run',
      acquired_at: '2026-07-23T00:00:00.000Z',
      hostname: 'testhost',
    };
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(holder), 'utf8');

    const now = () => new Date('2026-07-23T05:59:59.000Z'); // < 6h old
    expect(() => acquireLock(lockPath, 'my-run', now)).toThrow(LockError);
  });

  it('releaseLock only removes its own runId', () => {
    acquireLock(lockPath, 'run-1');

    releaseLock(lockPath, 'someone-else');
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseLock(lockPath, 'run-1');
    expect(fs.existsSync(lockPath)).toBe(false);

    // releasing when there is no lock is a no-op
    releaseLock(lockPath, 'run-1');
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
