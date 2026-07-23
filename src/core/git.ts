import { spawnSync } from 'node:child_process';

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirtyFiles: string[];
}

export interface GitOps {
  status(cwd: string): GitStatus;
  headCommit(cwd: string): string | null;
  commitAll(cwd: string, message: string): string | null;
  tag(cwd: string, name: string, message: string): boolean;
  init(cwd: string): boolean;
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}`.trim() };
}

export class SystemGit implements GitOps {
  status(cwd: string): GitStatus {
    const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.out !== 'true') return { isRepo: false, branch: null, dirtyFiles: [] };
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const porcelain = git(cwd, ['status', '--porcelain']);
    return {
      isRepo: true,
      branch: branch.code === 0 ? branch.out : null,
      dirtyFiles: porcelain.out ? porcelain.out.split('\n').map((l) => l.slice(3)) : [],
    };
  }

  headCommit(cwd: string): string | null {
    const r = git(cwd, ['rev-parse', 'HEAD']);
    return r.code === 0 ? r.out : null;
  }

  commitAll(cwd: string, message: string): string | null {
    if (git(cwd, ['add', '-A']).code !== 0) return null;
    if (git(cwd, ['commit', '-m', message]).code !== 0) return null;
    return this.headCommit(cwd);
  }

  tag(cwd: string, name: string, message: string): boolean {
    return git(cwd, ['tag', '-a', name, '-m', message]).code === 0;
  }

  init(cwd: string): boolean {
    return git(cwd, ['init', '-b', 'main']).code === 0;
  }
}

/** Test double: in-memory git. */
export class FakeGit implements GitOps {
  public commits: Array<{ message: string; hash: string }> = [];
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
  commitAll(_cwd: string, message: string): string | null {
    if (!this.repo) return null;
    const hash = `fake${String(++this.counter).padStart(6, '0')}`;
    this.commits.push({ message, hash });
    this.dirty = [];
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
}
