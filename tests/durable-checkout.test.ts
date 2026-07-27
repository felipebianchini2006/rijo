import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDurableWorkflowEngine } from '../src/durable/index.js';
import { silentSink } from '../src/core/progress.js';
import {
  completed,
  createContext,
  durableCheckpoint,
  withLock,
} from '../src/workflows/shared.js';
import { cleanup, tmpProject } from './helpers.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe('durable portable checkout boundary', () => {
  it('commits portable ledger artifacts while DB/WAL/backups remain ignored', async () => {
    const root = tmpProject('rijo-durable-checkout-');
    roots.push(root);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'rijo-test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'RIJO Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'PLANO.md'), '# Durable checkout\n');
    execFileSync('git', ['add', 'PLANO.md'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: root });

    const durable = await openDurableWorkflowEngine(root, {
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    });
    const ctx = createContext(root, { durable, sink: silentSink });
    await withLock(
      ctx,
      async () => {
        ctx.bus.emit('run.task_done', { message: 'implemented' });
        await durableCheckpoint(ctx, 'task:01:T01:verified', {
          commit: ctx.git.headCommit(root),
        });
        return completed(ctx, 'checkpoint complete');
      },
      { run: { plan: '# Durable checkout\n', host: 'codex' } },
    );

    expect(
      execFileSync('git', ['status', '--porcelain', '-uall'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ).toBe('');
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: root,
      encoding: 'utf8',
    }).split('\n');
    expect(tracked).not.toContain('.rijo/events.jsonl');
    expect(tracked.some((file) => file.startsWith('.rijo/ledger/'))).toBe(true);
    expect(tracked).not.toContain('.rijo/state/rijo.db');
    expect(tracked.some((file) => /rijo\.db-(?:wal|shm)$/.test(file))).toBe(false);
    expect(tracked.some((file) => file.startsWith('.rijo/state/backups/'))).toBe(false);
  });
});
