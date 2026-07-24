import { spawnSync } from 'node:child_process';

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirtyFiles: string[];
}

export interface GitOps {
  status(cwd: string): GitStatus;
  headCommit(cwd: string): string | null;
  /** Subject line of HEAD's commit message. Null outside a repo / no commits. */
  headSubject(cwd: string): string | null;
  /** Commit only the given paths (staged individually). Never `git add -A`. */
  commitPaths(cwd: string, message: string, paths: string[]): string | null;
  tag(cwd: string, name: string, message: string): boolean;
  init(cwd: string): boolean;
  /** Paths changed between two commits (name-only). Empty on error. */
  diffNames(cwd: string, from: string, to: string): string[];
  /** Detached checkout of an exact commit into a new directory (isolated verification workspace). */
  checkoutInto(cwd: string, commit: string, destDir: string): boolean;
}

function git(cwd: string, args: string[]): { code: number; out: string; raw: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const raw = `${r.stdout ?? ''}`;
  return { code: r.status ?? 1, out: raw.trim(), raw };
}

export class SystemGit implements GitOps {
  status(cwd: string): GitStatus {
    const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.out !== 'true') return { isRepo: false, branch: null, dirtyFiles: [] };
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const porcelain = git(cwd, ['status', '--porcelain', '-uall']);
    // parse per line from the RAW output: a whole-output trim would eat the
    // leading space of a " M file" entry on the first line and corrupt the path
    const dirtyFiles = porcelain.raw
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).replace(/^"|"$/g, ''));
    return {
      isRepo: true,
      branch: branch.code === 0 ? branch.out : null,
      dirtyFiles,
    };
  }

  headCommit(cwd: string): string | null {
    const r = git(cwd, ['rev-parse', 'HEAD']);
    return r.code === 0 ? r.out : null;
  }

  headSubject(cwd: string): string | null {
    const r = git(cwd, ['log', '-1', '--pretty=%s']);
    return r.code === 0 ? r.out : null;
  }

  /**
   * Commits need an author identity; environments without a configured
   * user.email (fresh CI runners, containers) get a per-invocation RIJO
   * fallback via `-c` — an existing user identity is never overridden.
   */
  private identityArgs(cwd: string): string[] {
    const email = git(cwd, ['config', 'user.email']);
    if (email.code === 0 && email.out) return [];
    return ['-c', 'user.name=RIJO', '-c', 'user.email=rijo@localhost'];
  }

  /**
   * Stage the exact paths given (and nothing else) and commit them. Pre-existing
   * unrelated changes in the working tree are left untouched, so an automatic
   * commit can never sweep in the user's own edits.
   */
  commitPaths(cwd: string, message: string, paths: string[]): string | null {
    if (paths.length === 0) return null;
    // stage each path explicitly; -A/. are deliberately never used
    if (git(cwd, ['add', '--', ...paths]).code !== 0) return null;
    // commit only the staged index for these paths
    if (git(cwd, [...this.identityArgs(cwd), 'commit', '-m', message, '--', ...paths]).code !== 0) return null;
    return this.headCommit(cwd);
  }

  tag(cwd: string, name: string, message: string): boolean {
    return git(cwd, [...this.identityArgs(cwd), 'tag', '-a', name, '-m', message]).code === 0;
  }

  init(cwd: string): boolean {
    return git(cwd, ['init', '-b', 'main']).code === 0;
  }

  diffNames(cwd: string, from: string, to: string): string[] {
    const r = git(cwd, ['diff', '--name-only', `${from}..${to}`]);
    return r.code === 0 && r.out ? r.out.split('\n').filter(Boolean) : [];
  }

  /**
   * Materialize the exact commit into destDir without touching the working
   * tree: `git worktree add --detach` gives a clean checkout that shares the
   * object store. Returns false when the commit does not exist.
   */
  checkoutInto(cwd: string, commit: string, destDir: string): boolean {
    return git(cwd, ['worktree', 'add', '--detach', destDir, commit]).code === 0;
  }
}

/** Test double: in-memory git. Tracks which paths were committed. */
export class FakeGit implements GitOps {
  public commits: Array<{ message: string; hash: string; paths: string[] }> = [];
  public tags: string[] = [];
  public dirty: string[] = [];
  public repo = true;
  private counter = 0;

  status(): GitStatus {
    return { isRepo: this.repo, branch: this.repo ? 'main' : null, dirtyFiles: [...this.dirty] };
  }
  headCommit(): string | null {
    return this.commits.length ? this.commits[this.commits.length - 1]!.hash : null;
  }
  headSubject(): string | null {
    return this.commits.length ? this.commits[this.commits.length - 1]!.message : null;
  }
  commitPaths(_cwd: string, message: string, paths: string[]): string | null {
    if (!this.repo || paths.length === 0) return null;
    const hash = `fake${String(++this.counter).padStart(6, '0')}`;
    this.commits.push({ message, hash, paths: [...paths] });
    // only the committed paths leave the dirty set
    this.dirty = this.dirty.filter((f) => !paths.includes(f));
    return hash;
  }
  tag(_cwd: string, name: string): boolean {
    this.tags.push(name);
    return true;
  }
  init(): boolean {
    this.repo = true;
    return true;
  }
  diffNames(_cwd: string, from: string, to: string): string[] {
    const idxFrom = this.commits.findIndex((c) => c.hash === from);
    const idxTo = this.commits.findIndex((c) => c.hash === to);
    if (idxFrom < 0 || idxTo < 0) return [];
    const names = new Set<string>();
    for (let i = idxFrom + 1; i <= idxTo; i++) for (const p of this.commits[i]!.paths) names.add(p);
    return [...names].sort();
  }
  checkoutInto(): boolean {
    return false; // in-memory double cannot materialize a checkout
  }
}
