import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AttemptWorkspace,
  SymlinkEscapeError,
  PatchConflictError,
  findEscapingSymlinks,
  snapshotTree,
} from '../src/core/workspace.js';
import { tmpProject, cleanup } from './helpers.js';

/**
 * Hard isolation guarantees, exercised on REAL directories (no mocks, no fakes):
 *  - an attempt gets its own `node_modules` clone, so nothing it does to the
 *    dependency tree can reach the project's;
 *  - a symlink that escapes the tree never enters a workspace and never leaves
 *    one, in either direction.
 */

function seedProject(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  fs.mkdirSync(path.join(root, '.rijo'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rijo', 'RULES.md'), '# Rules\n');
}

/** A small but REAL dependency tree: a package, an internal `.bin` shim. */
function seedNodeModules(root: string): void {
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(nm, 'fake-pkg', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'fake-pkg', 'package.json'), '{"name":"fake-pkg","version":"1.0.0","bin":{"fake":"cli.js"}}\n');
  fs.writeFileSync(path.join(nm, 'fake-pkg', 'cli.js'), '#!/usr/bin/env node\nconsole.log("fake v1");\n');
  fs.writeFileSync(path.join(nm, 'fake-pkg', 'lib', 'index.js'), 'module.exports = 1;\n');
  // exactly what npm writes: a RELATIVE link from .bin into the package
  fs.symlinkSync(path.join('..', 'fake-pkg', 'cli.js'), path.join(nm, '.bin', 'fake'));
}

/** Byte-exact fingerprint of a tree: relative path + kind + content/target. */
function fingerprint(dir: string): string {
  const lines: string[] = [];
  const walk = (cur: string) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const full = path.join(cur, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (e.isSymbolicLink()) lines.push(`L ${rel} -> ${fs.readlinkSync(full)}`);
      else if (e.isDirectory()) {
        lines.push(`D ${rel}`);
        walk(full);
      } else if (e.isFile()) {
        lines.push(`F ${rel} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

describe('attempt workspaces are Git-isolated from the controlled checkout', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-git-barrier-');
    seedProject(root);
    expect(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status).toBe(0);
  });
  afterEach(() => cleanup(root));

  it('prevents a host git command from discovering or staging into the parent repository', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'spec-01', writeScope: ['src/a.ts'] });

    const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: ws.root,
      encoding: 'utf8',
    });
    expect(topLevel.status).toBe(0);
    const detectedRoot = fs.statSync(topLevel.stdout.trim());
    const workspaceRoot = fs.statSync(ws.root);
    expect([detectedRoot.dev, detectedRoot.ino]).toEqual([workspaceRoot.dev, workspaceRoot.ino]);

    const staged = spawnSync('git', ['add', '-f', 'src/a.ts'], {
      cwd: ws.root,
      encoding: 'utf8',
    });
    expect(staged.status).toBe(0);
    ws.discard();
    expect(
      spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' }).stdout,
    ).not.toContain('.rijo/runtime/workspaces/');
  });

  it('excludes only volatile SQLite files while retaining durable migrations', () => {
    const state = path.join(root, '.rijo', 'state');
    fs.mkdirSync(path.join(state, 'backups'), { recursive: true });
    fs.mkdirSync(path.join(state, 'migrations'), { recursive: true });
    for (const name of ['rijo.db', 'rijo.db-wal', 'rijo.db-shm']) {
      fs.writeFileSync(path.join(state, name), name);
    }
    fs.writeFileSync(path.join(state, 'backups', '1.sqlite'), 'backup');
    fs.writeFileSync(path.join(state, 'migrations', '001.sql'), 'SELECT 1;');

    const snapshot = snapshotTree(root);
    expect(snapshot.has('.rijo/state/rijo.db')).toBe(false);
    expect(snapshot.has('.rijo/state/rijo.db-wal')).toBe(false);
    expect(snapshot.has('.rijo/state/rijo.db-shm')).toBe(false);
    expect(snapshot.has('.rijo/state/backups/1.sqlite')).toBe(false);
    expect(snapshot.has('.rijo/state/migrations/001.sql')).toBe(true);
  });
});

describe('node_modules is cloned, never shared with the checkout', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject('rijo-nm-');
    seedProject(root);
    seedNodeModules(root);
  });
  afterEach(() => cleanup(root));

  it('the workspace gets a real directory (not a link, not the same inodes)', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    const wsNm = path.join(ws.root, 'node_modules');
    expect(fs.lstatSync(wsNm).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(wsNm).isDirectory()).toBe(true);
    // distinct inodes: a hardlink (same inode) would leak every write back
    const projectFile = path.join(root, 'node_modules', 'fake-pkg', 'cli.js');
    const wsFile = path.join(wsNm, 'fake-pkg', 'cli.js');
    expect(fs.statSync(wsFile).ino).not.toBe(fs.statSync(projectFile).ino);
    expect(fs.readFileSync(wsFile, 'utf8')).toBe(fs.readFileSync(projectFile, 'utf8'));
    ws.discard();
  });

  it('the internal .bin shim still resolves inside the workspace', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    const bin = path.join(ws.root, 'node_modules', '.bin', 'fake');
    expect(fs.lstatSync(bin).isSymbolicLink()).toBe(true);
    // it dereferences to the COPY, not to the project's package
    expect(fs.realpathSync(bin)).toBe(fs.realpathSync(path.join(ws.root, 'node_modules', 'fake-pkg', 'cli.js')));
    expect(fs.readFileSync(bin, 'utf8')).toContain('fake v1');
    ws.discard();
  });

  it('an attempt that rewrites and deletes dependencies leaves the project tree byte-identical', () => {
    const before = fingerprint(path.join(root, 'node_modules'));
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    const wsNm = path.join(ws.root, 'node_modules');

    // the attempt vandalises its dependency tree in every way it can
    fs.writeFileSync(path.join(wsNm, 'fake-pkg', 'cli.js'), 'console.log("PWNED");\n');
    fs.writeFileSync(path.join(wsNm, 'fake-pkg', 'package.json'), '{"name":"fake-pkg","version":"666.0.0"}\n');
    fs.rmSync(path.join(wsNm, 'fake-pkg', 'lib', 'index.js'));
    fs.rmSync(path.join(wsNm, '.bin', 'fake'));
    fs.writeFileSync(path.join(wsNm, 'implanted.js'), 'module.exports = "backdoor";\n');
    // and does its legitimate in-scope work
    fs.writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'export const a = 42;\n');

    // the ORIGINAL dependency tree is untouched, byte for byte
    expect(fingerprint(path.join(root, 'node_modules'))).toBe(before);
    expect(fs.readFileSync(path.join(root, 'node_modules', 'fake-pkg', 'cli.js'), 'utf8')).toContain('fake v1');
    expect(fs.existsSync(path.join(root, 'node_modules', 'fake-pkg', 'lib', 'index.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'node_modules', 'implanted.js'))).toBe(false);

    // node_modules stays OUT of the delta: not added, not modified, not removed
    const delta = ws.collectDelta();
    expect(delta.changed.filter((p) => p.startsWith('node_modules'))).toEqual([]);
    expect(delta.changed).toEqual(['src/a.ts']);

    ws.applyVerifiedPatch();
    // the apply propagates only the source edit; dependencies remain identical
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 42');
    expect(fingerprint(path.join(root, 'node_modules'))).toBe(before);
    ws.discard();
    expect(fingerprint(path.join(root, 'node_modules'))).toBe(before);
  });

  it('a dependency link pointing outside the workspace is dropped and reported', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-global-'));
    try {
      fs.writeFileSync(path.join(outside, 'index.js'), 'module.exports = "host package";\n');
      // exactly what `npm link` leaves behind: a package linked out of the tree
      fs.symlinkSync(outside, path.join(root, 'node_modules', 'linked-pkg'));

      const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
      expect(fs.existsSync(path.join(ws.root, 'node_modules', 'linked-pkg'))).toBe(false);
      expect(ws.droppedDependencyLinks).toEqual(['node_modules/linked-pkg']);
      // the host directory the link pointed at was never followed nor copied
      expect(fs.readFileSync(path.join(outside, 'index.js'), 'utf8')).toBe('module.exports = "host package";\n');
      expect(fs.readdirSync(outside)).toEqual(['index.js']);
      ws.discard();
    } finally {
      cleanup(outside);
    }
  });

  it('a project without node_modules is still isolated (creation just proceeds)', () => {
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    expect(fs.existsSync(path.join(ws.root, 'node_modules'))).toBe(false);
    expect(ws.droppedDependencyLinks).toEqual([]);
    fs.writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'export const a = 7;\n');
    ws.applyVerifiedPatch();
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 7');
    ws.discard();
  });
});

describe('symlink escape protection', () => {
  let root: string;
  let outside: string;
  let victim: string;
  beforeEach(() => {
    root = tmpProject('rijo-sym-');
    seedProject(root);
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-victim-'));
    victim = path.join(outside, 'victim.txt');
    fs.writeFileSync(victim, 'host secret\n');
  });
  afterEach(() => {
    cleanup(root);
    cleanup(outside);
  });

  it('(a) a pre-existing escaping link refuses workspace creation, fail-closed', () => {
    fs.symlinkSync(victim, path.join(root, 'src', 'leak.txt'));
    expect(findEscapingSymlinks(root)).toEqual(['src/leak.txt']);
    let thrown: unknown;
    try {
      AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SymlinkEscapeError);
    const err = thrown as SymlinkEscapeError;
    expect(err.phase).toBe('pre-create');
    expect(err.offending).toEqual(['src/leak.txt']);
    expect(err.message).toContain('src/leak.txt');
    expect(err.message).toContain('No workspace was created for T01');
    // nothing was copied: no workspace dir survives the refusal
    const wsDir = path.join(root, '.rijo', 'runtime', 'workspaces');
    expect(!fs.existsSync(wsDir) || fs.readdirSync(wsDir).length === 0).toBe(true);
    // and the host file was never read through, let alone written
    expect(fs.readFileSync(victim, 'utf8')).toBe('host secret\n');
  });

  it('(a) a link climbing out with ../ is refused just like an absolute one', () => {
    fs.symlinkSync(path.join('..', '..', 'escape-hatch'), path.join(root, 'src', 'up.txt'));
    expect(findEscapingSymlinks(root)).toEqual(['src/up.txt']);
    expect(() => AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] })).toThrow(SymlinkEscapeError);
  });

  it('(b) a link the attempt creates towards a host file blocks validate and apply', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    fs.symlinkSync(victim, path.join(ws.root, 'src', 'escape.txt'));

    const beforeApply = fs.readFileSync(victim, 'utf8');
    expect(() => ws.validate()).toThrow(SymlinkEscapeError);
    expect(() => ws.applyVerifiedPatch()).toThrow(SymlinkEscapeError);
    try {
      ws.validate();
    } catch (err) {
      expect((err as SymlinkEscapeError).offending).toEqual(['src/escape.txt']);
      expect((err as SymlinkEscapeError).phase).toBe('apply');
    }
    // the checkout never gains the link, so the host file stays unreachable
    // from the project, and neither validate nor apply wrote through it
    expect(fs.existsSync(path.join(root, 'src', 'escape.txt'))).toBe(false);
    expect(fs.readFileSync(victim, 'utf8')).toBe(beforeApply);
    expect(fs.readFileSync(victim, 'utf8')).toBe('host secret\n');
    ws.discard();
  });

  it('(b) writing through an attempt-created link never propagates: the apply is blocked', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    fs.symlinkSync(victim, path.join(ws.root, 'src', 'escape.txt'));
    // The attempt writes through its own link. In production a spawned command
    // is fenced by the OS sandbox (writes confined to the workspace); what THIS
    // layer guarantees is that the result never reaches the checkout.
    fs.writeFileSync(path.join(ws.root, 'src', 'escape.txt'), 'pwned\n');
    const afterAttempt = fs.readFileSync(victim, 'utf8');

    expect(() => ws.applyVerifiedPatch()).toThrow(SymlinkEscapeError);
    // from the moment RIJO takes over, the host file is untouched
    expect(fs.readFileSync(victim, 'utf8')).toBe(afterAttempt);
    // and the checkout gained neither the link nor its content
    expect(fs.existsSync(path.join(root, 'src', 'escape.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 1');
    ws.discard();
  });

  it('(b) a link that repoints an existing file outside the tree is caught too', () => {
    fs.writeFileSync(path.join(root, 'src', 'conf.txt'), 'inert\n');
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    // the attempt swaps a regular in-scope file for a link to the host
    fs.rmSync(path.join(ws.root, 'src', 'conf.txt'));
    fs.symlinkSync(victim, path.join(ws.root, 'src', 'conf.txt'));
    expect(() => ws.validate()).toThrow(SymlinkEscapeError);
    expect(fs.lstatSync(path.join(root, 'src', 'conf.txt')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(victim, 'utf8')).toBe('host secret\n');
    ws.discard();
  });

  it('(b) an absolute target is an escape even when it points back inside the checkout', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    // resolves inside the WORKSPACE today, but applied verbatim it would point
    // at a workspace that is about to be discarded
    fs.symlinkSync(path.join(ws.root, 'src', 'a.ts'), path.join(ws.root, 'src', 'abs-link.ts'));
    expect(() => ws.validate()).toThrow(SymlinkEscapeError);
    ws.discard();
  });

  it('(b) a checkout path swapped for an escaping link is never written through', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/a.ts'] });
    fs.writeFileSync(path.join(ws.root, 'src', 'a.ts'), 'export const a = 99;\n');
    // meanwhile the checkout file becomes a link to the host file
    fs.rmSync(path.join(root, 'src', 'a.ts'));
    fs.symlinkSync(victim, path.join(root, 'src', 'a.ts'));

    expect(() => ws.applyVerifiedPatch()).toThrow(PatchConflictError);
    expect(fs.readFileSync(victim, 'utf8')).toBe('host secret\n');
    ws.discard();
  });

  it('(c) an internal link keeps working, and writes through it apply normally', () => {
    fs.symlinkSync(path.join('.', 'a.ts'), path.join(root, 'src', 'alias.ts'));
    expect(findEscapingSymlinks(root)).toEqual([]);

    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    const wsAlias = path.join(ws.root, 'src', 'alias.ts');
    expect(fs.lstatSync(wsAlias).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(wsAlias, 'utf8')).toContain('a = 1');

    // the attempt writes THROUGH the internal link: the real file changes
    fs.writeFileSync(wsAlias, 'export const a = 5;\n');
    const delta = ws.validate();
    expect(delta.changed).toEqual(['src/a.ts']);

    ws.applyVerifiedPatch();
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 5;\n');
    // the link itself survives the apply, still a link with the same target
    expect(fs.lstatSync(path.join(root, 'src', 'alias.ts')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(root, 'src', 'alias.ts'))).toBe(path.join('.', 'a.ts'));
    ws.discard();
  });

  it('(c) an attempt may create a NEW internal link and it is applied verbatim', () => {
    const ws = AttemptWorkspace.create(root, { taskId: 'T01', writeScope: ['src/**'] });
    fs.symlinkSync(path.join('.', 'b.ts'), path.join(ws.root, 'src', 'b-alias.ts'));
    const delta = ws.validate();
    expect(delta.symlinks).toEqual(['src/b-alias.ts']);
    ws.applyVerifiedPatch();
    const applied = path.join(root, 'src', 'b-alias.ts');
    expect(fs.lstatSync(applied).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(applied, 'utf8')).toContain('b = 2');
    ws.discard();
  });
});
