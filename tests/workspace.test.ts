import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AttemptWorkspace,
  snapshotTree,
  diffTrees,
  WorkspaceScopeError,
  CanonicalWriteError,
  SymlinkEscapeError,
  PatchConflictError,
} from '../src/core/workspace.js';
import { tmpProject, cleanup } from './helpers.js';

function seedProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  fs.mkdirSync(path.join(root, '.rijo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rijo', 'RULES.md'), '# Rules\n');
}

describe('AttemptWorkspace', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-ws-');
    seedProject(root);
  });
  afterEach(() => cleanup(root));

  it('isolates writes: nothing reaches the checkout until applyVerifiedPatch', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    fs.writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'export const a = 42;\n');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    const applied = ws.applyVerifiedPatch();
    expect(applied.applied).toEqual(['src/a.ts']);
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 42');
    ws.discard();
    expect(fs.existsSync(ws.root)).toBe(false);
  });

  it('the real delta includes additions, modifications, removals and renames', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    fs.writeFileSync(path.join(ws.root, 'src', 'new.ts'), 'export const n = 3;\n');
    fs.writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'export const a = 9;\n');
    fs.renameSync(path.join(ws.root, 'src', 'b.ts'), path.join(ws.root, 'src', 'renamed.ts'));
    const delta = ws.collectDelta();
    expect(delta.added.sort()).toEqual(['src/new.ts', 'src/renamed.ts']);
    expect(delta.modified).toEqual(['src/a.ts']);
    expect(delta.removed).toEqual(['src/b.ts']);
    expect(delta.renamed).toEqual([{ from: 'src/b.ts', to: 'src/renamed.ts' }]);
    // removals propagate on apply
    ws.applyVerifiedPatch();
    expect(fs.existsSync(path.join(root, 'src', 'b.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src', 'renamed.ts'))).toBe(true);
    ws.discard();
  });

  it('scope is enforced on the REAL delta, ignoring the agent report', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    fs.writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'ok\n');
    fs.writeFileSync(path.join(ws.root, 'src', 'b.ts'), 'HIDDEN OUT OF SCOPE\n');
    expect(() => ws.validate()).toThrow(WorkspaceScopeError);
    // discarding leaves the checkout pristine — even the in-scope edit
    ws.discard();
    expect(fs.readFileSync(path.join(root, 'src', 'b.ts'), 'utf8')).toContain('b = 2');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
  });

  it('a rename with the destination outside the scope is a violation', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/b.ts'] });
    fs.renameSync(path.join(ws.root, 'src', 'b.ts'), path.join(ws.root, 'src', 'elsewhere.ts'));
    expect(() => ws.validate()).toThrow(WorkspaceScopeError);
    ws.discard();
  });

  it('.rijo canonical files are read-only for attempts without core authorization', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    fs.writeFileSync(path.join(ws.root, '.rijo', 'RULES.md'), '# Hacked rules\n');
    expect(() => ws.validate()).toThrow(CanonicalWriteError);
    ws.discard();
    expect(fs.readFileSync(path.join(root, '.rijo', 'RULES.md'), 'utf8')).toBe('# Rules\n');
  });

  it('an explicitly authorized canonical write is allowed', () => {
    const ws = AttemptWorkspace.create(root, {
      taskId: 'spec',
      writeScope: ['.rijo/SPEC-DRAFT.md'],
      canonicalWriteScope: ['.rijo/SPEC-DRAFT.md'],
    });
    fs.writeFileSync(path.join(ws.root, '.rijo', 'SPEC-DRAFT.md'), '# Spec\n');
    const applied = ws.applyVerifiedPatch();
    expect(applied.applied).toEqual(['.rijo/SPEC-DRAFT.md']);
    ws.discard();
  });

  it('symlinks pointing outside the workspace are rejected', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    fs.symlinkSync('/etc/passwd', path.join(ws.root, 'src', 'evil-link'));
    expect(() => ws.validate()).toThrow(SymlinkEscapeError);
    ws.discard();
  });

  it('a concurrent checkout change produces an explicit conflict with NO partial merge', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts', 'src/b.ts'] });
    fs.writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'attempt version a\n');
    fs.writeFileSync(path.join(ws.root, 'src', 'b.ts'), 'attempt version b\n');
    // the USER edits src/b.ts in the checkout while the attempt runs
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'user concurrent edit\n');
    expect(() => ws.applyVerifiedPatch()).toThrow(PatchConflictError);
    // NOTHING was applied — not even the conflict-free src/a.ts
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    expect(fs.readFileSync(path.join(root, 'src', 'b.ts'), 'utf8')).toBe('user concurrent edit\n');
    ws.discard();
  });

  it('a failed attempt never contaminates the next one (clean baseline)', () => {
    const ws1 = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    fs.writeFileSync(path.join(ws1.root, 'src', 'a.ts'), 'garbage from failed attempt\n');
    ws1.discard(); // attempt 1 failed → discarded whole
    const ws2 = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    expect(fs.readFileSync(path.join(ws2.root, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    ws2.discard();
  });

  it('two parallel workspaces with disjoint scopes both apply cleanly', () => {
    const wsA = AttemptWorkspace.create(root, { taskId: 'TA', writeScope: ['src/a.ts'] });
    const wsB = AttemptWorkspace.create(root, { taskId: 'TB', writeScope: ['src/b.ts'] });
    fs.writeFileSync(path.join(wsA.root, 'src', 'a.ts'), 'A changed\n');
    fs.writeFileSync(path.join(wsB.root, 'src', 'b.ts'), 'B changed\n');
    wsA.applyVerifiedPatch();
    wsB.applyVerifiedPatch();
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('A changed\n');
    expect(fs.readFileSync(path.join(root, 'src', 'b.ts'), 'utf8')).toBe('B changed\n');
    wsA.discard();
    wsB.discard();
  });

  it('snapshotTree/diffTrees track symlink changes', () => {
    const before = snapshotTree(root);
    fs.symlinkSync('src/a.ts', path.join(root, 'link.ts'));
    const delta = diffTrees(before, snapshotTree(root));
    expect(delta.added).toEqual(['link.ts']);
    expect(delta.symlinks).toEqual(['link.ts']);
  });
});
