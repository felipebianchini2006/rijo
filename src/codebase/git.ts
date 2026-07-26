import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HistoryRecordSchema, type HistoryRecord } from './schemas.js';

interface GitResult {
  code: number;
  out: string;
  raw: string;
}

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const raw = `${result.stdout ?? ''}`;
  return { code: result.status ?? 1, out: raw.trim(), raw };
}

export interface RepositoryMetadata {
  root: string;
  is_repo: boolean;
  branch: string;
  head: string;
}

export interface GitDrift {
  accessible: boolean;
  changed: string[];
  added: string[];
  modified: string[];
  deleted: string[];
  renames: Array<{ from: string; to: string }>;
}

/**
 * Compare two already-resolved filesystem paths with the host filesystem's
 * casing semantics. Windows may return the same real path with drive/directory
 * casing inherited from different APIs (for example Git vs fs.realpathSync).
 */
export function sameFilesystemPath(
  left: string,
  right: string,
  caseInsensitive = process.platform === 'win32',
): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return caseInsensitive
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

export function resolveRepositoryMetadata(start: string): RepositoryMetadata {
  const real = fs.realpathSync(start);
  const top = git(real, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { root: real, is_repo: false, branch: 'NO_GIT', head: 'UNCOMMITTED' };
  const root = fs.realpathSync(top.out);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(root, ['rev-parse', 'HEAD']);
  return {
    root,
    is_repo: true,
    branch: branch.code === 0 ? branch.out : 'DETACHED',
    head: head.code === 0 ? head.out : 'UNCOMMITTED',
  };
}

export function commitAccessible(root: string, commit: string): boolean {
  if (!commit || commit === 'UNCOMMITTED') return false;
  return git(root, ['cat-file', '-e', `${commit}^{commit}`]).code === 0;
}

function relevant(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  return !(norm === '.rijo' || norm.startsWith('.rijo/') || norm === '.DS_Store' || norm.endsWith('/.DS_Store'));
}

export function gitDrift(root: string, from: string, to = 'HEAD'): GitDrift {
  if (!commitAccessible(root, from)) {
    return { accessible: false, changed: [], added: [], modified: [], deleted: [], renames: [] };
  }
  const result = git(root, ['diff', '--name-status', '--find-renames', `${from}..${to}`]);
  if (result.code !== 0) return { accessible: false, changed: [], added: [], modified: [], deleted: [], renames: [] };
  const changed = new Set<string>();
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  for (const line of result.raw.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split('\t');
    const status = fields[0] ?? '';
    if (status.startsWith('R') && fields[1] && fields[2]) {
      if (relevant(fields[1])) changed.add(fields[1]);
      if (relevant(fields[2])) changed.add(fields[2]);
      if (relevant(fields[1]) || relevant(fields[2])) renames.push({ from: fields[1], to: fields[2] });
      continue;
    }
    const file = fields[1];
    if (!file || !relevant(file)) continue;
    changed.add(file);
    if (status.startsWith('A')) added.push(file);
    else if (status.startsWith('D')) deleted.push(file);
    else modified.push(file);
  }
  return {
    accessible: true,
    changed: [...changed].sort(),
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    renames,
  };
}

/** Dirty checkout paths, excluding only RIJO-authorized volatile state. */
export function dirtyApplicationPaths(root: string, allowed: string[] = []): string[] {
  const result = git(root, ['status', '--porcelain', '-z', '-uall']);
  if (result.code !== 0) return [];
  const allowedSet = new Set(allowed.map((p) => p.replace(/\\/g, '/')));
  const out: string[] = [];
  const fields = result.raw.split('\0').filter(Boolean);
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]!;
    const status = record.slice(0, 2);
    let rel = record.slice(3).replace(/\\/g, '/');
    if (status.startsWith('R') || status.startsWith('C')) {
      const target = fields[++i];
      if (target) rel = target.replace(/\\/g, '/');
    }
    if (
      rel === '.rijo/events.jsonl' ||
      rel.startsWith('.rijo/runtime/') ||
      rel.startsWith('.rijo/archive/') ||
      allowedSet.has(rel)
    ) {
      continue;
    }
    out.push(rel);
  }
  return [...new Set(out)].sort();
}

function migrationPath(file: string): boolean {
  return /(^|\/)(migrations?|prisma\/migrations|supabase\/migrations|drizzle\/migrations)(\/|$)/i.test(file);
}

export function collectGitHistory(root: string, limit = 250): HistoryRecord {
  const result = git(root, [
    'log',
    `-${limit}`,
    '--date=iso-strict',
    '--format=@@@%H%x09%ad%x09%s',
    '--name-status',
    '--find-renames',
  ]);
  if (result.code !== 0) {
    return HistoryRecordSchema.parse({
      commits_analyzed: 0,
      renames: [],
      churn: [],
      cochange: [],
      architectural_commits: [],
      migrations: [],
      hotspots: [],
    });
  }

  const commits: Array<{ hash: string; subject: string; paths: string[] }> = [];
  const renames: HistoryRecord['renames'] = [];
  const migrations: HistoryRecord['migrations'] = [];
  let current: { hash: string; subject: string; paths: string[] } | null = null;
  for (const line of result.raw.split(/\r?\n/)) {
    if (line.startsWith('@@@')) {
      const [hash = '', , subject = ''] = line.slice(3).split('\t');
      current = { hash, subject, paths: [] };
      commits.push(current);
      continue;
    }
    if (!current || !line.includes('\t')) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (status.startsWith('R') && parts[1] && parts[2]) {
      current.paths.push(parts[1], parts[2]);
      renames.push({ from: parts[1], to: parts[2], commit: current.hash });
      if (migrationPath(parts[2])) migrations.push({ path: parts[2], commit: current.hash });
    } else if (parts[1]) {
      current.paths.push(parts[1]);
      if (migrationPath(parts[1])) migrations.push({ path: parts[1], commit: current.hash });
    }
  }

  const churnCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const commit of commits) {
    const paths = [...new Set(commit.paths.filter(relevant))].sort();
    for (const file of paths) churnCounts.set(file, (churnCounts.get(file) ?? 0) + 1);
    const modules = [...new Set(paths.map((p) => p.split('/').slice(0, p.startsWith('apps/') || p.startsWith('packages/') ? 2 : 1).join('/')))].sort();
    for (let i = 0; i < modules.length; i++) {
      for (let j = i + 1; j < modules.length; j++) {
        const key = `${modules[i]}\0${modules[j]}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const churn = [...churnCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50)
    .map(([file, changes]) => ({ path: file, changes }));
  const cochange = [...pairCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([key, count]) => ({ paths: key.split('\0'), commits: count }));
  const architectural = commits
    .filter((c) => /(arch|refactor|migration|breaking|contract|schema|monorepo|workspace|api)/i.test(c.subject))
    .slice(0, 30)
    .map((c) => ({ commit: c.hash, subject: c.subject, paths: [...new Set(c.paths)].slice(0, 20) }));
  const bugCounts = new Map<string, number>();
  for (const commit of commits.filter((c) => /(fix|bug|hotfix|regression|security)/i.test(c.subject))) {
    for (const file of new Set(commit.paths)) bugCounts.set(file, (bugCounts.get(file) ?? 0) + 1);
  }
  const hotspots = churn
    .map((entry) => {
      const bugs = bugCounts.get(entry.path) ?? 0;
      return {
        path: entry.path,
        score: entry.changes + bugs * 2,
        reasons: [`${entry.changes} commits in sampled history`, ...(bugs ? [`${bugs} bug/security commits`] : [])],
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  return HistoryRecordSchema.parse({
    commits_analyzed: commits.length,
    renames,
    churn,
    cochange,
    architectural_commits: architectural,
    migrations,
    hotspots,
  });
}
