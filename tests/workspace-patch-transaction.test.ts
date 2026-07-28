import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RijoPaths } from '../src/core/paths.js';
import { reconcileTransactions } from '../src/core/txn.js';
import { AttemptWorkspace, diffTrees, snapshotTree } from '../src/core/workspace.js';
import { cleanup, tmpProject } from './helpers.js';

function seedProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'binary.dat'), Buffer.from([0, 1, 2, 255]));
  fs.writeFileSync(path.join(root, 'src', 'remove.txt'), 'remove me\n');
  fs.writeFileSync(path.join(root, 'src', 'rename-from.txt'), 'rename me\n');
  fs.writeFileSync(path.join(root, 'src', 'link-target-a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'src', 'link-target-b.txt'), 'b\n');
  fs.symlinkSync('link-target-a.txt', path.join(root, 'src', 'current.txt'));
}

function mutateWorkspace(workspaceRoot: string): void {
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'binary.dat'), Buffer.from([255, 0, 128, 64]));
  fs.rmSync(path.join(workspaceRoot, 'src', 'remove.txt'));
  fs.renameSync(
    path.join(workspaceRoot, 'src', 'rename-from.txt'),
    path.join(workspaceRoot, 'src', 'rename-to.txt'),
  );
  fs.rmSync(path.join(workspaceRoot, 'src', 'current.txt'));
  fs.symlinkSync('link-target-b.txt', path.join(workspaceRoot, 'src', 'current.txt'));
}

function crashAt(step: string) {
  return {
    afterWrite: (actual: string) => {
      if (actual === step) throw new Error(`INJECTED-CRASH after ${step}`);
    },
  };
}

describe('verified workspace patch transactions', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) cleanup(root);
  });

  it('rolls back durable staging when a crash occurs before the commit marker', () => {
    const root = tmpProject('rijo-workspace-precommit-');
    roots.push(root);
    seedProject(root);
    const before = snapshotTree(root);
    const workspace = AttemptWorkspace.create(root, {
      taskId: 'T01',
      writeScope: ['src/**'],
      transactionHooks: crashAt('operations'),
    });
    mutateWorkspace(workspace.root);

    expect(() => workspace.applyVerifiedPatch()).toThrow('INJECTED-CRASH after operations');
    expect(diffTrees(before, snapshotTree(root)).changed).toEqual([]);

    const first = reconcileTransactions(new RijoPaths(root));
    expect(first.rolledBack).toHaveLength(1);
    expect(first.rolledForward).toEqual([]);
    expect(diffTrees(before, snapshotTree(root)).changed).toEqual([]);

    expect(reconcileTransactions(new RijoPaths(root))).toEqual({
      rolledForward: [],
      rolledBack: [],
    });
  });

  it('rolls a committed patch forward after a mid-apply crash and recovery is idempotent', () => {
    const root = tmpProject('rijo-workspace-midapply-');
    roots.push(root);
    seedProject(root);
    const workspace = AttemptWorkspace.create(root, {
      taskId: 'T02',
      writeScope: ['src/**'],
      transactionHooks: crashAt('apply-pre-rename:file:src/binary.dat'),
    });
    mutateWorkspace(workspace.root);
    const expected = snapshotTree(workspace.root);

    expect(() => workspace.applyVerifiedPatch()).toThrow(
      'INJECTED-CRASH after apply-pre-rename:file:src/binary.dat',
    );
    expect(fs.readdirSync(path.join(root, 'src')).some((name) => name.startsWith('.rijo-txn-'))).toBe(true);

    const transactionRoot = path.join(root, '.rijo', 'runtime', 'transactions');
    const transaction = fs.readdirSync(transactionRoot)[0]!;
    const operations = JSON.parse(
      fs.readFileSync(path.join(transactionRoot, transaction, 'operations.json'), 'utf8'),
    ) as { operations: Array<Record<string, unknown>> };
    expect(
      operations.operations.find((operation) => operation['path'] === 'src/current.txt'),
    ).toMatchObject({
      type: 'symlink',
      path: 'src/current.txt',
      target: 'link-target-b.txt',
    });
    expect(
      fs.existsSync(path.join(transactionRoot, transaction, 'staged', 'src', 'current.txt')),
    ).toBe(false);

    const first = reconcileTransactions(new RijoPaths(root));
    expect(first.rolledForward).toEqual([transaction]);
    expect(first.rolledBack).toEqual([]);
    expect(diffTrees(expected, snapshotTree(root)).changed).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'src', 'binary.dat'))).toEqual(
      Buffer.from([255, 0, 128, 64]),
    );
    expect(fs.existsSync(path.join(root, 'src', 'remove.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'rename-from.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'src', 'rename-to.txt'), 'utf8')).toBe('rename me\n');
    expect(fs.lstatSync(path.join(root, 'src', 'current.txt')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(root, 'src', 'current.txt'))).toBe('link-target-b.txt');
    expect(fs.readdirSync(path.join(root, 'src')).some((name) => name.startsWith('.rijo-txn-'))).toBe(false);

    expect(reconcileTransactions(new RijoPaths(root))).toEqual({
      rolledForward: [],
      rolledBack: [],
    });
    expect(diffTrees(expected, snapshotTree(root)).changed).toEqual([]);
  });

  it('does not overwrite an external edit made after a retained patch commit', () => {
    const root = tmpProject('rijo-workspace-retained-conflict-');
    roots.push(root);
    seedProject(root);
    const workspace = AttemptWorkspace.create(root, {
      taskId: 'exec-01-T01',
      writeScope: ['src/binary.dat'],
    });
    fs.writeFileSync(
      path.join(workspace.root, 'src', 'binary.dat'),
      Buffer.from([9, 8, 7, 6]),
    );

    const applied = workspace.applyVerifiedPatch({
      taskPatch: { milestone: 'M001', phase: '01', task: 'T01' },
    });
    expect(applied.transaction_id).not.toBeNull();
    fs.writeFileSync(path.join(root, 'src', 'binary.dat'), Buffer.from('external edit'));

    expect(() => reconcileTransactions(new RijoPaths(root))).toThrow(
      /did not overwrite these paths/,
    );
    expect(fs.readFileSync(path.join(root, 'src', 'binary.dat'))).toEqual(
      Buffer.from('external edit'),
    );
    expect(
      fs.existsSync(
        path.join(root, '.rijo', 'runtime', 'transactions', applied.transaction_id!),
      ),
    ).toBe(true);
  });
});
