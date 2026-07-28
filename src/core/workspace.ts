import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, exists, sha256 } from './fsx.js';
import { RijoPaths } from './paths.js';
import { pathInScope } from './scope.js';
import {
  MilestoneTransaction,
  type TaskPatchProjection,
  type TxnHooks,
  type TxnPathState,
} from './txn.js';
import { isSensitivePath } from '../security/sensitive.js';

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
  if (
    parts[0] === '.rijo' &&
    parts[1] === 'state' &&
    (
      parts[2] === 'rijo.db' ||
      parts[2] === 'rijo.db-wal' ||
      parts[2] === 'rijo.db-shm' ||
      parts[2] === 'backups'
    )
  ) {
    return true;
  }
  // Credentials never enter a workspace: excluded from the snapshot, therefore
  // from the copy, from the delta and from any patch applied back.
  if (isSensitivePath(rel)) return true;
  return false;
}

/** True when `candidate` is `root` itself or lives under it (pure path math, never follows links). */
function containedIn(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return !path.isAbsolute(rel) && !rel.split(path.sep).includes('..');
}

/**
 * A symlink escapes `root` when its target is absolute or climbs out of the
 * tree. Absolute targets count as escapes even when they happen to point back
 * inside the same checkout: the copy that lands in another tree (the workspace,
 * or the checkout on apply) would still dereference to the ORIGINAL location,
 * which is exactly the isolation hole this guards.
 */
function linkEscapes(root: string, linkAbs: string, target: string): boolean {
  if (path.isAbsolute(target)) return true;
  return !containedIn(root, path.resolve(path.dirname(linkAbs), target));
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

/**
 * Every symlink in the project tree whose target escapes `projectRoot`.
 * Copying such a link into a workspace would defeat the isolation: reading
 * through it leaves the sandbox and writing through it reaches the host
 * filesystem. Workspace creation refuses to start while one exists
 * (fail-closed) instead of silently omitting it, because an omitted path
 * changes what the agent sees without anyone being told.
 * `node_modules` is not part of this set — it is machine-generated, is cloned
 * separately and has its own (omit-and-report) policy.
 */
export function findEscapingSymlinks(projectRoot: string, snapshot?: TreeSnapshot): string[] {
  const snap = snapshot ?? snapshotTree(projectRoot);
  const escaping: string[] = [];
  for (const [rel, entry] of snap) {
    if (entry.symlinkTarget === null) continue;
    if (linkEscapes(projectRoot, path.join(projectRoot, rel), entry.symlinkTarget)) escaping.push(rel);
  }
  return escaping.sort();
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

/**
 * A symlink would carry writes out of the isolated tree. Raised in two phases:
 * `pre-create` (the project already contains an escaping link, so no workspace
 * is built at all) and `apply` (the attempt produced one, so nothing is
 * applied).
 */
export class SymlinkEscapeError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly offending: string[],
    public readonly phase: 'pre-create' | 'apply' = 'apply',
  ) {
    super(
      phase === 'pre-create'
        ? `No workspace was created for ${taskId}: the project contains symlinks whose target is absolute or ` +
            `escapes the project root, and copying them would break the attempt's isolation: ${offending.join(', ')}`
        : `Attempt ${taskId} introduced symlinks pointing outside the workspace: ${offending.join(', ')}`,
    );
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
  transaction_id: string | null;
}

export interface ApplyVerifiedPatchOptions {
  taskPatch?: Pick<TaskPatchProjection, 'milestone' | 'phase' | 'task'>;
}

export interface AttemptWorkspaceOptions {
  taskId: string;
  writeScope: string[];
  /** canonical .rijo paths (relative, forward-slash) the CORE explicitly authorizes this attempt to write. */
  canonicalWriteScope?: string[];
  baselineCommit?: string | null;
  /** hash of the canonical baseline (manifest hashes) this attempt started from. */
  baselineCanonicalHash?: string;
  /** Test seam for durable patch fault injection. */
  transactionHooks?: TxnHooks;
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
    /**
     * Dependency links dropped while cloning node_modules because they pointed
     * outside the workspace (globally linked packages, a shared store, a parent
     * repo). Kept as evidence: an attempt that cannot resolve a dependency has
     * an auditable reason instead of a silent omission.
     */
    public readonly droppedDependencyLinks: string[],
    private readonly baseline: TreeSnapshot,
    private readonly transactionHooks: TxnHooks,
  ) {}

  /**
   * Create an isolated copy of the project for one attempt. Symlinks are
   * preserved verbatim and never dereferenced; a project that already contains
   * a symlink escaping its root is refused outright (fail-closed) before a
   * single byte is copied. `node_modules` is CLONED, never linked: a writable
   * link to the checkout's dependency tree would let an attempt rewrite the
   * real project's dependencies. It stays out of the delta either way.
   */
  static create(projectRoot: string, opts: AttemptWorkspaceOptions): AttemptWorkspace {
    const id = `ws-${opts.taskId}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const root = path.join(projectRoot, '.rijo', 'runtime', 'workspaces', id);
    const baseline = snapshotTree(projectRoot);
    const escaping = findEscapingSymlinks(projectRoot, baseline);
    if (escaping.length > 0) throw new SymlinkEscapeError(opts.taskId, escaping, 'pre-create');
    ensureDir(root);
    copyTree(projectRoot, root, baseline);
    // The workspace lives below the controlled checkout. Without a local Git
    // boundary, `git add`/`git status` run by a host climbs to the parent's
    // `.git` directory and can stage volatile workspace paths in the real
    // repository. A minimal valid repository makes Git stop at the attempt
    // root; commands may use a disposable local index but can never mutate the
    // controlled checkout. `.git` is excluded from snapshots and deltas, so
    // the barrier can never be applied back as task output.
    initializeGitBarrier(root);
    const droppedDependencyLinks = isolateNodeModules(projectRoot, root);
    return new AttemptWorkspace(
      id,
      root,
      projectRoot,
      opts.taskId,
      opts.writeScope.map((s) => s.replace(/\\/g, '/')),
      (opts.canonicalWriteScope ?? []).map((s) => s.replace(/\\/g, '/')),
      opts.baselineCommit ?? null,
      opts.baselineCanonicalHash ?? '',
      droppedDependencyLinks,
      baseline,
      opts.transactionHooks ?? {},
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

    // Re-checked against the CURRENT link on disk, not the snapshot: this
    // covers a link the agent created pointing outside, a pre-existing link
    // whose target it repointed, and any link it swapped between the snapshot
    // and this call. An absolute target is an escape even when it currently
    // resolves inside the workspace — applied verbatim to the checkout it would
    // still point back at the discarded workspace.
    const escapes: string[] = [];
    for (const rel of delta.symlinks) {
      const linkAbs = path.join(this.root, rel);
      let target: string;
      try {
        target = fs.readlinkSync(linkAbs);
      } catch {
        continue; // no longer a symlink: covered by the hash/target diff above
      }
      if (linkEscapes(this.root, linkAbs, target)) escapes.push(rel);
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
  applyVerifiedPatch(options: ApplyVerifiedPatchOptions = {}): AppliedPatch {
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
    const transaction = MilestoneTransaction.begin(
      new RijoPaths(this.projectRoot),
      {
        kind: 'task-patch',
        prev: this.baselineCanonicalHash || null,
        next: sha256(
          JSON.stringify({
            task_id: this.taskId,
            workspace_id: this.id,
            changed: delta.changed,
          }),
        ),
        ...(options.taskPatch
          ? {
              task_patch: {
                ...options.taskPatch,
                worker_task: this.taskId,
                retain_after_apply: true as const,
              },
            }
          : {}),
      },
      this.transactionHooks,
    );
    const beforeState = (rel: string): TxnPathState => {
      const entry = this.baseline.get(rel);
      if (!entry) return { kind: 'absent' };
      return entry.symlinkTarget === null
        ? { kind: 'file', sha256: entry.hash! }
        : { kind: 'symlink', target: entry.symlinkTarget };
    };
    for (const rel of delta.removed) transaction.stageDelete(rel, beforeState(rel));
    for (const rel of [...delta.added, ...delta.modified]) {
      const source = path.join(this.root, rel);
      const entry = after.get(rel)!;
      if (entry.symlinkTarget !== null) {
        transaction.stageSymlink(rel, entry.symlinkTarget, beforeState(rel));
      } else {
        transaction.stageBytes(
          rel,
          fs.readFileSync(source),
          fs.statSync(source).mode & 0o777,
          beforeState(rel),
        );
      }
    }
    transaction.commitPoint();
    transaction.apply();
    if (!options.taskPatch) transaction.finish();
    return {
      applied: delta.changed,
      renamed: delta.renamed,
      transaction_id: options.taskPatch ? transaction.id : null,
    };
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

function initializeGitBarrier(workspaceRoot: string): void {
  const gitDir = path.join(workspaceRoot, '.git');
  ensureDir(path.join(gitDir, 'objects'));
  ensureDir(path.join(gitDir, 'refs', 'heads'));
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/rijo-attempt\n');
  fs.writeFileSync(
    path.join(gitDir, 'config'),
    [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tfilemode = false',
      '\tbare = false',
      '\tlogallrefupdates = false',
      '',
    ].join('\n'),
  );
  // Seed only the disposable local index. This makes `git diff`/`git status`
  // useful to cooperative hosts without creating a commit or touching the
  // parent repository. If Git is unavailable, the on-disk boundary above still
  // prevents repository discovery from escaping the workspace.
  spawnSync('git', ['add', '-A'], { cwd: workspaceRoot, stdio: 'ignore' });
}

/**
 * Remove every leftover attempt workspace under `<runtimeDir>/workspaces`
 * except workspaces still owned by a durable non-terminal task record.
 * A crashed run can leave whole workspace copies behind; a fresh run must
 * never observe or reuse them (a stale copy could re-introduce a discarded
 * attempt's edits). Returns the ids of the workspaces that were removed so the
 * caller can emit progress; safe to call when the directory does not exist.
 */
export function discardOrphanWorkspaces(
  runtimeDir: string,
  activeWorkspaceIds: ReadonlySet<string> = new Set(),
): string[] {
  const wsDir = path.join(runtimeDir, 'workspaces');
  if (!exists(wsDir)) return [];
  const discarded: string[] = [];
  for (const entry of fs.readdirSync(wsDir)) {
    if (activeWorkspaceIds.has(entry)) continue;
    fs.rmSync(path.join(wsDir, entry), { recursive: true, force: true });
    discarded.push(entry);
  }
  return discarded;
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function copyTree(from: string, to: string, snapshot: TreeSnapshot): void {
  for (const [rel, entry] of snapshot) {
    const src = path.join(from, rel);
    const dst = path.join(to, rel);
    ensureDir(path.dirname(dst));
    try {
      // Links are recreated verbatim from the snapshot target — the source is
      // never dereferenced, so no content from outside the tree is ever pulled
      // in (and escaping links were already refused before the copy started).
      if (entry.symlinkTarget !== null) fs.symlinkSync(entry.symlinkTarget, dst);
      else fs.copyFileSync(src, dst);
    } catch {
      /* source vanished mid-copy; the baseline snapshot remains authoritative */
    }
  }
}

/**
 * Give the attempt its OWN dependency tree. The workspace used to receive a
 * writable link to the checkout's `node_modules`, so an attempt could rewrite
 * or delete the real project's dependencies through it. The directory is
 * cloned instead:
 *  - macOS: `cp -Rc` (APFS clonefile) — copy-on-write, near-instant, and the
 *    first write to a cloned file allocates its own blocks;
 *  - elsewhere: a real recursive copy that keeps symlinks verbatim.
 * Hardlinks are never an option: a shared inode means every write inside the
 * workspace lands in the checkout's dependency tree.
 * Returns the links dropped for pointing outside the workspace.
 */
function isolateNodeModules(projectRoot: string, root: string): string[] {
  const nm = path.join(projectRoot, 'node_modules');
  if (!exists(nm)) return []; // no dependencies installed: nothing to isolate
  // A `node_modules` that is itself a link is cloned by CONTENT — recreating
  // the link would hand the attempt the very write-through path being closed.
  let src = nm;
  try {
    if (isSymlink(nm)) src = fs.realpathSync(nm);
  } catch {
    return [];
  }
  const dst = path.join(root, 'node_modules');
  if (!cloneDirectory(src, dst)) return []; // tooling just won't resolve deps
  const dropped: string[] = [];
  pruneEscapingLinks(dst, root, dropped);
  return dropped.sort();
}

/** Deep copy that never dereferences symlinks. False when the copy could not be made. */
function cloneDirectory(src: string, dst: string): boolean {
  if (process.platform === 'darwin') {
    const cloned = spawnSync('cp', ['-Rc', src, dst], { stdio: 'ignore' });
    if (cloned.status === 0) return true;
    fs.rmSync(dst, { recursive: true, force: true }); // partial clone, start over
  }
  try {
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, force: true });
    return true;
  } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    return false;
  }
}

/**
 * Drop every link under `dir` whose target leaves `root`. A cloned
 * `node_modules` can carry links to a global store, a linked package or a
 * parent repository; following them would put the attempt back on the host
 * filesystem. Links that stay inside the workspace — `.bin` shims and
 * npm-workspace package links — are kept so tooling still resolves.
 */
function pruneEscapingLinks(dir: string, root: string, dropped: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.readlinkSync(full);
      } catch {
        continue;
      }
      if (!linkEscapes(root, full, target)) continue;
      fs.rmSync(full, { force: true });
      dropped.push(path.relative(root, full).split(path.sep).join('/'));
    } else if (e.isDirectory()) {
      pruneEscapingLinks(full, root, dropped);
    }
  }
}
