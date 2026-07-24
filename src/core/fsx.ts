import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Deterministic filesystem helpers. All canonical writes go through
 * writeFileAtomic so a crash can never leave a half-written artifact.
 */

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

export function readText(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

export function readTextIfExists(p: string): string | null {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

export function readJson<T = unknown>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

export function readJsonIfExists<T = unknown>(p: string): T | null {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as T) : null;
}

/**
 * Write via temp file + fsync + rename in the same directory (atomic on POSIX
 * and NTFS). The temp file is flushed to disk before the rename so a crash
 * cannot leave a torn file, and the existing target is never destroyed until
 * its replacement is safely in place — if anything fails, the original stays.
 */
export function writeFileAtomic(p: string, content: string): void {
  ensureDir(path.dirname(p));
  const suffix = `${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}`;
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${suffix}.tmp`);
  // write + flush the temp file durably
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, p);
    return;
  } catch (err) {
    // Windows can refuse rename over an existing/locked target. Move the
    // original aside first so it is recoverable if the second rename fails.
    if (!fs.existsSync(p)) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const backup = path.join(path.dirname(p), `.${path.basename(p)}.${suffix}.bak`);
    fs.renameSync(p, backup); // original preserved as backup
    try {
      fs.renameSync(tmp, p);
      fs.rmSync(backup, { force: true });
    } catch (err2) {
      // restore the original; leave the tree exactly as it was
      try {
        fs.renameSync(backup, p);
      } catch {
        /* backup is the only survivor; surface the failure */
      }
      fs.rmSync(tmp, { force: true });
      throw err2;
    }
  }
}

export function writeJsonAtomic(p: string, value: unknown): void {
  writeFileAtomic(p, JSON.stringify(value, null, 2) + '\n');
}

export function appendLine(p: string, line: string): void {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n', 'utf8');
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256File(p: string): string {
  return sha256(fs.readFileSync(p));
}

export function fileSize(p: string): number {
  return fs.statSync(p).size;
}

export interface InventoryEntry {
  relPath: string;
  size: number;
}

/** Recursive file inventory relative to root, skipping the given directory names. */
export function inventory(
  root: string,
  opts: { skipDirs?: string[]; maxEntries?: number } = {},
): InventoryEntry[] {
  const skip = new Set(opts.skipDirs ?? ['node_modules', '.git', 'dist', '.next', 'coverage']);
  const max = opts.maxEntries ?? 20000;
  const out: InventoryEntry[] = [];
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full);
      } else if (e.isFile()) {
        out.push({ relPath: path.relative(root, full).split(path.sep).join('/'), size: fs.statSync(full).size });
      }
    }
  };
  walk(root);
  return out;
}

/** Total byte size of a set of files that exist. Used to enforce the context budget. */
export function totalSize(paths: string[]): number {
  return paths.filter((p) => fs.existsSync(p)).reduce((acc, p) => acc + fs.statSync(p).size, 0);
}

/** Reject paths that escape the workspace root. */
export function assertInsideRoot(root: string, candidate: string): string {
  const resolved = path.resolve(root, candidate);
  const rel = path.relative(path.resolve(root), resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
  throw new Error(`Path escapes workspace root: ${candidate}`);
}
