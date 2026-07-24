import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, exists, sha256 } from './fsx.js';
import { pathInScope } from './scope.js';

/**
 * Real per-attempt isolation. A worker NEVER writes to the controlled checkout:
 * it receives an isolated copy of the project (one workspace per attempt, even
 * in parallel groups), the core computes the REAL delta of that copy —
 * additions, modifications, removals, renames and symlinks, `.rijo` included —
 * validates it against the individual task's write scope, and only then applies
 * the verified patch back to the checkout with conflict detection. A failed,
 * lying, timed-out or scope-violating attempt is discarded whole; nothing it
 * did can contaminate the checkout or the next attempt.
 */

/** Directories never copied into (or compared inside) a workspace. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);
/** Volatile RIJO internals excluded from copy and delta (never canonical). */
const RIJO_VOLATILE = new Set(['runtime', 'archive', 'events.jsonl']);

export interface TreeEntry {
  /** sha256 of content for regular files; null for symlinks */
  hash: string | null;
  /** link target for symlinks; null for regular files */
  symlinkTarget: string | null;
}
export type TreeSnapshot = Map<string, TreeEntry>;

function shouldSkip(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (parts[0] === '.rijo' && parts.length > 1 && RIJO_VOLATILE.has(parts[1]!)) return true;
  return false;
}

/**
 * Snapshot a tree INCLUDING `.rijo` canonical files and symlinks. This is the
 * control snapshot for workspaces — unlike core/scope.snapshotFiles (which
 * exists for coarse project diffs and skips `.rijo`), nothing controlled is
 * omitted here.
 */
export function snapshotTree(root: string): TreeSnapshot {
  const snap: TreeSnapshot = new Map();
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (shouldSkip(rel)) continue;
      if (e.isSymbolicLink()) {
        try {
          snap.set(rel, { hash: null, symlinkTarget: fs.readlinkSync(full) });
        } catch {
          /* vanished mid-scan */
        }
      } else if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        try {
          snap.set(rel, { hash: sha256(fs.readFileSync(full)), symlinkTarget: null });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  };
  walk(root);
  return snap;
}

export interface WorkspaceDelta {
  added: string[];
  modified: string[];
  removed: string[];
  /** removed+added pairs with identical content, reported as renames */
  renamed: Array<{ from: string; to: string }>;
  /** paths that are symlinks in the final state */
  symlinks: string[];
  /** every path that changed in any way (renames appear as both paths) */
  changed: string[];
}

export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): WorkspaceDelta {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const symlinks: string[] = [];
  for (const [rel, entry] of after) {
    const prev = before.get(rel);
    if (!prev) added.push(rel);
    else if (prev.hash !== entry.hash || prev.symlinkTarget !== entry.symlinkTarget) modified.push(rel);
    if (entry.symlinkTarget !== null && (!prev || prev.symlinkTarget !== entry.symlinkTarget)) symlinks.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);

  // rename detection: identical content hash disappearing at one path and
  // appearing at another. Both sides remain part of `changed` — a rename must
  // have BOTH endpoints inside the write scope.
  const renamed: Array<{ from: string; to: string }> = [];
  const removedByHash = new Map<string, string>();
  for (const rel of removed) {
    const h = before.get(rel)?.hash;
    if (h) removedByHash.set(h, rel);
  }
  for (const rel of added) {
    const h = after.get(rel)?.hash;
    if (h && removedByHash.has(h)) {
      renamed.push({ from: removedByHash.get(h)!, to: rel });
      removedByHash.delete(h);
    }
  }
  return { added, modified, removed, renamed, symlinks, changed: [...added, ...modified, ...removed].sort() };
}

export class WorkspaceScopeError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly offending: string[],
  ) {
    super(
      `Attempt ${taskId} changed paths outside its individual write scope ` +
        `(real filesystem delta, agent report ignored): ${offending.join(', ')}`,
    );
    this.name = 'WorkspaceScopeError';
  }
}

export class CanonicalWriteError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly offending: string[],
  ) {
    super(
      `Attempt ${taskId} modified canonical .rijo files without core authorization: ${offending.join(', ')}`,
    );
    this.name = 'CanonicalWriteError';
  }
}

export class SymlinkEscapeError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly offending: string[],
  ) {
    super(`Attempt ${taskId} introduced symlinks pointing outside the workspace: ${offending.join(', ')}`);
    this.name = 'SymlinkEscapeError';
  }
}

export class PatchConflictError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly conflicts: string[],
  ) {
    super(
      `Attempt ${taskId}: the checkout changed concurrently for ${conflicts.join(', ')}; ` +
        `the verified patch was NOT applied (no partial merge).`,
    );
    this.name = 'PatchConflictError';
  }
}

export interface AppliedPatch {
  applied: string[];
  renamed: Array<{ from: string; to: string }>;
}

export interface AttemptWorkspaceOptions {
  taskId: string;
  writeScope: string[];
  /** canonical .rijo paths (relative, forward-slash) the CORE explicitly authorizes this attempt to write. */
  canonicalWriteScope?: string[];
  baselineCommit?: string | null;
  /** hash of the canonical baseline (manifest hashes) this attempt started from. */
  baselineCanonicalHash?: string;
}

export class AttemptWorkspace {
  private discarded = false;
  private constructor(
    public readonly id: string,
    public readonly root: string,
    public readonly projectRoot: string,
    public readonly taskId: string,
    public readonly writeScope: string[],
    public readonly canonicalWriteScope: string[],
    public readonly baselineCommit: string | null,
    public readonly baselineCanonicalHash: string,
    private readonly baseline: TreeSnapshot,
  ) {}

  /**
   * Create an isolated copy of the project for one attempt. Symlinks are
   * preserved verbatim; node_modules is linked read-through (never copied,
   * never diffed) so repository tooling still resolves inside the workspace.
   */
  static create(projectRoot: string, opts: AttemptWorkspaceOptions): AttemptWorkspace {
    const id = `ws-${opts.taskId}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const root = path.join(projectRoot, '.rijo', 'runtime', 'workspaces', id);
    const baseline = snapshotTree(projectRoot);
    ensureDir(root);
    copyTree(projectRoot, root, baseline);
    const nm = path.join(projectRoot, 'node_modules');
    if (exists(nm)) {
      try {
        fs.symlinkSync(nm, path.join(root, 'node_modules'), 'junction');
      } catch {
        /* link failed: tooling inside the workspace just won't resolve deps */
      }
    }
    return new AttemptWorkspace(
      id,
      root,
      projectRoot,
      opts.taskId,
      opts.writeScope.map((s) => s.replace(/\\/g, '/')),
      (opts.canonicalWriteScope ?? []).map((s) => s.replace(/\\/g, '/')),
      opts.baselineCommit ?? null,
      opts.baselineCanonicalHash ?? '',
      baseline,
    );
  }

  /** The REAL delta of this workspace relative to its creation baseline. */
  collectDelta(): WorkspaceDelta {
    this.assertLive();
    return diffTrees(this.baseline, snapshotTree(this.root));
  }

  /**
   * Enforce the attempt's individual boundaries on the real delta:
   *  - every changed path inside the task's OWN write scope (never a union);
   *  - `.rijo` canonical files untouched unless core-authorized;
   *  - no symlink pointing outside the workspace.
   * Throws; the caller discards the workspace on any violation.
   */
  validate(): WorkspaceDelta {
    const delta = this.collectDelta();
    const canonical = delta.changed.filter((p) => p === '.rijo' || p.startsWith('.rijo/'));
    const unauthorizedCanonical = canonical.filter((p) => !pathInScope(p, this.canonicalWriteScope));
    if (unauthorizedCanonical.length > 0) throw new CanonicalWriteError(this.taskId, unauthorizedCanonical);

    const nonCanonical = delta.changed.filter((p) => !(p === '.rijo' || p.startsWith('.rijo/')));
    const offending = nonCanonical.filter((p) => !pathInScope(p, this.writeScope));
    if (offending.length > 0) throw new WorkspaceScopeError(this.taskId, offending);

    const escapes: string[] = [];
    for (const rel of delta.symlinks) {
      const target = fs.readlinkSync(path.join(this.root, rel));
      const resolved = path.resolve(path.dirname(path.join(this.root, rel)), target);
      const inside = !path.relative(this.root, resolved).startsWith('..') && !path.isAbsolute(path.relative(this.root, resolved));
      if (!inside) escapes.push(rel);
    }
    if (escapes.length > 0) throw new SymlinkEscapeError(this.taskId, escapes);
    return delta;
  }

  /**
   * Apply the validated delta to the controlled checkout. ALL-OR-NOTHING:
   * every affected checkout path must still match this workspace's creation
   * baseline (no concurrent user or sibling change); one conflict aborts the
   * whole apply with no partial merge.
   */
  applyVerifiedPatch(): AppliedPatch {
    const delta = this.validate();
    const current = snapshotTree(this.projectRoot);
    const conflicts: string[] = [];
    for (const rel of delta.changed) {
      const base = this.baseline.get(rel) ?? null;
      const now = current.get(rel) ?? null;
      const same =
        (base === null && now === null) ||
        (base !== null && now !== null && base.hash === now.hash && base.symlinkTarget === now.symlinkTarget);
      if (!same) conflicts.push(rel);
    }
    if (conflicts.length > 0) throw new PatchConflictError(this.taskId, conflicts);

    const after = snapshotTree(this.root);
    for (const rel of [...delta.added, ...delta.modified]) {
      const src = path.join(this.root, rel);
      const dst = path.join(this.projectRoot, rel);
      ensureDir(path.dirname(dst));
      const entry = after.get(rel)!;
      if (entry.symlinkTarget !== null) {
        fs.rmSync(dst, { force: true });
        fs.symlinkSync(entry.symlinkTarget, dst);
      } else {
        fs.copyFileSync(src, dst);
      }
    }
    for (const rel of delta.removed) {
      fs.rmSync(path.join(this.projectRoot, rel), { force: true });
    }
    return { applied: delta.changed, renamed: delta.renamed };
  }

  /** Remove the workspace entirely. Idempotent. */
  discard(): void {
    if (this.discarded) return;
    this.discarded = true;
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  private assertLive(): void {
    if (this.discarded) throw new Error(`Workspace ${this.id} was discarded`);
  }
}

/**
 * Remove every leftover attempt workspace under `<runtimeDir>/workspaces`.
 * A crashed run can leave whole workspace copies behind; a fresh run must
 * never observe or reuse them (a stale copy could re-introduce a discarded
 * attempt's edits). Returns the ids of the workspaces that were removed so the
 * caller can emit progress; safe to call when the directory does not exist.
 */
export function discardOrphanWorkspaces(runtimeDir: string): string[] {
  const wsDir = path.join(runtimeDir, 'workspaces');
  if (!exists(wsDir)) return [];
  const discarded: string[] = [];
  for (const entry of fs.readdirSync(wsDir)) {
    fs.rmSync(path.join(wsDir, entry), { recursive: true, force: true });
    discarded.push(entry);
  }
  return discarded;
}

function copyTree(from: string, to: string, snapshot: TreeSnapshot): void {
  for (const [rel, entry] of snapshot) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    ensureDir(path.dirname(dst));
    try {
      if (entry.symlinkTarget !== null) fs.symlinkSync(entry.symlinkTarget, dst);
      else fs.copyFileSync(src, dst);
    } catch {
      /* source vanished mid-copy; the baseline snapshot remains authoritative */
    }
  }
}
