import { inventory, sha256File } from './fsx.js';

/**
 * Write-scope enforcement by REAL filesystem delta, not by what the agent
 * claims. A snapshot of file hashes is taken before a task runs and compared
 * afterwards; every path that actually changed must fall inside the union of
 * the declared write scopes, regardless of the agent's self-reported
 * files_written. This defeats an agent that edits a file and omits it.
 */

export type FileSnapshot = Map<string, string>;

const DEFAULT_SKIP = ['node_modules', '.git', 'dist', '.next', 'coverage', '.rijo'];

/** Hash every file under root (skipping RIJO internals and build output). */
export function snapshotFiles(root: string, skipDirs: string[] = DEFAULT_SKIP): FileSnapshot {
  const snap: FileSnapshot = new Map();
  for (const entry of inventory(root, { skipDirs })) {
    try {
      snap.set(entry.relPath, sha256File(`${root}/${entry.relPath}`));
    } catch {
      /* file vanished mid-scan; ignore */
    }
  }
  return snap;
}

export interface SnapshotDelta {
  added: string[];
  modified: string[];
  removed: string[];
  /** all paths that changed in any way */
  changed: string[];
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): SnapshotDelta {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [rel, hash] of after) {
    if (!before.has(rel)) added.push(rel);
    else if (before.get(rel) !== hash) modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);
  return { added, modified, removed, changed: [...added, ...modified, ...removed].sort() };
}

/** Does a relative path fall within a declared write-scope pattern? */
export function pathInScope(rel: string, scopes: string[]): boolean {
  const p = rel.replace(/\\/g, '/');
  for (const raw of scopes) {
    const scope = raw.replace(/\\/g, '/');
    if (scope === '**') return true;
    if (scope === p) return true;
    if (scope.endsWith('/**') && (p === scope.slice(0, -3) || p.startsWith(scope.slice(0, -2)))) return true;
    if (scope.endsWith('/') && p.startsWith(scope)) return true;
    // treat a bare directory scope "src/x" as covering "src/x/..."
    if (!scope.includes('*') && p.startsWith(scope + '/')) return true;
  }
  return false;
}

export class ScopeDiffViolationError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly offending: string[],
  ) {
    super(
      `Task ${taskId} changed files outside its declared write scope (detected by filesystem diff, ` +
        `not the agent's report): ${offending.join(', ')}`,
    );
    this.name = 'ScopeDiffViolationError';
  }
}

/**
 * Enforce that every actually-changed path is inside the allowed scopes.
 * Throws ScopeDiffViolationError listing the offending paths.
 */
export function enforceScopeDelta(taskId: string, delta: SnapshotDelta, allowedScopes: string[]): void {
  if (allowedScopes.includes('**')) return;
  const offending = delta.changed.filter((p) => !pathInScope(p, allowedScopes));
  if (offending.length > 0) throw new ScopeDiffViolationError(taskId, offending);
}
