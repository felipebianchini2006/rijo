import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, exists, readJsonIfExists, appendLine } from './fsx.js';
import type { RijoPaths } from './paths.js';

/**
 * Crash-safe milestone transaction. All artifacts of a milestone transition
 * are generated into a staging area first; NOTHING outside
 * `.rijo/runtime/transactions/` is mutated before the single atomic commit
 * point (the fsync'd commit.json marker). After the commit point, applying the
 * staged files is deterministic and idempotent, so a crash at any moment
 * leaves the project either fully in the OLD state (no commit marker →
 * rollback discards staging) or deterministically reachable NEW state (commit
 * marker present → roll-forward re-applies staging). No intermediate state is
 * ever observable outside the runtime directory.
 */

export interface TxnIntent {
  kind: string;
  prev: string | null;
  next: string;
  created_at: string;
}

export interface TxnHooks {
  /** test seam: fault injection after each durable write ("crash here"). */
  afterWrite?: (step: string) => void;
}

function fsyncFile(p: string): void {
  const fd = fs.openSync(p, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeDurable(p: string, content: string): void {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
  fsyncFile(p);
}

export class MilestoneTransaction {
  private constructor(
    public readonly id: string,
    public readonly dir: string,
    private readonly projectRoot: string,
    private readonly hooks: TxnHooks,
  ) {}

  static begin(paths: RijoPaths, intent: Omit<TxnIntent, 'created_at'>, hooks: TxnHooks = {}, now: () => Date = () => new Date()): MilestoneTransaction {
    const id = `tx-${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const dir = path.join(paths.runtimeDir, 'transactions', id);
    ensureDir(path.join(dir, 'staged'));
    const txn = new MilestoneTransaction(id, dir, paths.projectRoot, hooks);
    writeDurable(path.join(dir, 'intent.json'), JSON.stringify({ ...intent, created_at: now().toISOString() }, null, 2));
    txn.receipt('intent-written');
    hooks.afterWrite?.('intent');
    return txn;
  }

  private receipt(step: string): void {
    appendLine(path.join(this.dir, 'receipts.jsonl'), JSON.stringify({ step, ts: new Date().toISOString() }));
  }

  /** Stage the FULL final content of one project-relative file. */
  stage(relPath: string, content: string): void {
    const norm = relPath.replace(/\\/g, '/');
    if (norm.startsWith('..') || path.isAbsolute(norm)) throw new Error(`Staged path escapes the project: ${relPath}`);
    writeDurable(path.join(this.dir, 'staged', norm), content);
    this.receipt(`staged:${norm}`);
    this.hooks.afterWrite?.(`stage:${norm}`);
  }

  /** Record a directory that must exist in the final state (idempotent on apply). */
  stageDir(relPath: string): void {
    const norm = relPath.replace(/\\/g, '/');
    appendLine(path.join(this.dir, 'dirs.list'), norm);
    this.receipt(`dir:${norm}`);
    this.hooks.afterWrite?.(`dir:${norm}`);
  }

  /**
   * THE atomic commit point. Before this returns, nothing outside runtime/
   * changed; after it, the transaction WILL complete (here or on the next
   * startup's roll-forward).
   */
  commitPoint(): void {
    writeDurable(path.join(this.dir, 'commit.json'), JSON.stringify({ committed_at: new Date().toISOString() }));
    this.receipt('commit-point');
    this.hooks.afterWrite?.('commit');
  }

  /** Apply staged state to the real tree. Deterministic and idempotent. */
  apply(): string[] {
    return applyStaged(this.dir, this.projectRoot, this.hooks);
  }

  /** Mark complete and remove the transaction directory. */
  finish(): void {
    writeDurable(path.join(this.dir, 'done'), 'done\n');
    this.receipt('done');
    this.hooks.afterWrite?.('finish');
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

function listStaged(dir: string): string[] {
  const stagedRoot = path.join(dir, 'staged');
  if (!exists(stagedRoot)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(stagedRoot, full).split(path.sep).join('/'));
    }
  };
  walk(stagedRoot);
  return out.sort();
}

function applyStaged(dir: string, projectRoot: string, hooks: TxnHooks = {}): string[] {
  const applied: string[] = [];
  const dirsList = path.join(dir, 'dirs.list');
  if (exists(dirsList)) {
    for (const rel of fs.readFileSync(dirsList, 'utf8').split('\n').filter(Boolean)) {
      ensureDir(path.join(projectRoot, rel));
    }
  }
  for (const rel of listStaged(dir)) {
    const src = path.join(dir, 'staged', rel);
    const dst = path.join(projectRoot, rel);
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    fsyncFile(dst);
    applied.push(rel);
    hooks.afterWrite?.(`apply:${rel}`);
  }
  return applied;
}

export interface ReconcileReport {
  rolledForward: string[];
  rolledBack: string[];
}

/**
 * Startup reconciliation: a transaction without its commit marker never
 * touched the real tree → rollback (discard staging). One WITH the marker is
 * rolled forward by re-applying its staged state (idempotent), then removed.
 */
export function reconcileTransactions(paths: RijoPaths): ReconcileReport {
  const report: ReconcileReport = { rolledForward: [], rolledBack: [] };
  const txRoot = path.join(paths.runtimeDir, 'transactions');
  if (!exists(txRoot)) return report;
  for (const entry of fs.readdirSync(txRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(txRoot, entry.name);
    if (exists(path.join(dir, 'commit.json'))) {
      applyStaged(dir, paths.projectRoot);
      report.rolledForward.push(entry.name);
    } else {
      report.rolledBack.push(entry.name);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return report;
}
