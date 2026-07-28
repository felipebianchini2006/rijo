import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, exists, sha256 } from './fsx.js';
import type { RijoPaths } from './paths.js';

/**
 * Crash-safe project transaction. All bytes and operation intent are durable
 * before the atomic commit marker appears. A transaction without that marker
 * can be discarded because it did not touch the project tree. A transaction
 * with that marker is applied deterministically until every operation is
 * complete.
 */

export interface TxnIntent {
  kind: string;
  prev: string | null;
  next: string;
  created_at: string;
}

export interface TxnHooks {
  /** Test seam. A thrown error simulates a process crash after a durable step. */
  afterWrite?: (step: string) => void;
}

interface DirectoryOperation {
  type: 'directory';
  path: string;
}

interface DeleteOperation {
  type: 'delete';
  path: string;
}

interface FileOperation {
  type: 'file';
  path: string;
  sha256: string;
  size: number;
  mode: number;
}

interface SymlinkOperation {
  type: 'symlink';
  path: string;
  target: string;
}

type TxnOperation = DirectoryOperation | DeleteOperation | FileOperation | SymlinkOperation;

interface OperationDocument {
  version: 2;
  operations: TxnOperation[];
}

interface CommitMarkerV2 {
  version: 2;
  operations_sha256: string;
  committed_at: string;
}

function ignorableFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EBADF' || code === 'EPERM';
}

function fsyncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!ignorableFsyncError(error)) throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function durableTempName(destination: string): string {
  const suffix = `${process.pid}.${Math.floor(Math.random() * 1e9).toString(36)}`;
  return path.join(path.dirname(destination), `.${path.basename(destination)}.${suffix}.tmp`);
}

function projectTempName(destination: string, transactionId: string, rel: string): string {
  const token = sha256(`${transactionId}\0${rel}`).slice(0, 20);
  return path.join(path.dirname(destination), `.rijo-txn-${token}.tmp`);
}

function writeDurableAtomic(destination: string, content: string | Buffer, mode?: number): void {
  const parent = path.dirname(destination);
  ensureDir(parent);
  const temporary = durableTempName(destination);
  const fd = fs.openSync(temporary, 'wx', mode);
  try {
    if (typeof content === 'string') fs.writeFileSync(fd, content, 'utf8');
    else fs.writeFileSync(fd, content);
    if (mode !== undefined) fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, destination);
    fsyncDirectory(parent);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function appendReceipt(dir: string, step: string): void {
  const receipt = path.join(dir, 'receipts.jsonl');
  fs.appendFileSync(receipt, `${JSON.stringify({ step, ts: new Date().toISOString() })}\n`, 'utf8');
}

function normalizeTxnPath(input: string): string {
  const slash = input.replace(/\\/g, '/');
  if (slash === '' || slash === '.' || path.posix.isAbsolute(slash)) {
    throw new Error(`Staged path is not project-relative: ${input}`);
  }
  const normalized = path.posix.normalize(slash);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== slash) {
    throw new Error(`Staged path escapes or is not normalized: ${input}`);
  }
  return normalized;
}

function containedIn(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
}

function assertSafeSymlink(projectRoot: string, rel: string, target: string): void {
  if (target === '' || path.isAbsolute(target)) {
    throw new Error(`Transaction symlink escapes the project: ${rel} -> ${target}`);
  }
  const destination = path.join(projectRoot, rel);
  if (!containedIn(projectRoot, path.resolve(path.dirname(destination), target))) {
    throw new Error(`Transaction symlink escapes the project: ${rel} -> ${target}`);
  }
}

/**
 * Reject a destination with a symbolic-link parent. The operation may replace
 * a link at its exact destination, but it never writes or removes through one.
 */
function assertNoSymlinkParent(projectRoot: string, rel: string): void {
  const segments = rel.split('/');
  let current = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (!exists(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Transaction destination has a symbolic-link parent: ${rel}`);
    }
  }
}

function operationRank(operation: TxnOperation): number {
  if (operation.type === 'directory') return 0;
  if (operation.type === 'delete') return 1;
  if (operation.type === 'file') return 2;
  return 3;
}

function orderOperations(operations: Iterable<TxnOperation>): TxnOperation[] {
  return [...operations].sort(
    (left, right) => left.path.localeCompare(right.path) || operationRank(left) - operationRank(right),
  );
}

export class MilestoneTransaction {
  private readonly operations = new Map<string, TxnOperation>();

  private constructor(
    public readonly id: string,
    public readonly dir: string,
    private readonly projectRoot: string,
    private readonly hooks: TxnHooks,
  ) {}

  static begin(
    paths: RijoPaths,
    intent: Omit<TxnIntent, 'created_at'>,
    hooks: TxnHooks = {},
    now: () => Date = () => new Date(),
  ): MilestoneTransaction {
    const id = `tx-${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const dir = path.join(paths.runtimeDir, 'transactions', id);
    ensureDir(path.join(dir, 'staged'));
    fsyncDirectory(path.dirname(dir));
    const txn = new MilestoneTransaction(id, dir, paths.projectRoot, hooks);
    writeDurableAtomic(
      path.join(dir, 'intent.json'),
      `${JSON.stringify({ ...intent, created_at: now().toISOString() }, null, 2)}\n`,
    );
    txn.receipt('intent-written');
    hooks.afterWrite?.('intent');
    return txn;
  }

  private receipt(step: string): void {
    appendReceipt(this.dir, step);
  }

  private setOperation(operation: TxnOperation): void {
    this.operations.set(operation.path, operation);
  }

  /** Stage the full final UTF-8 content of one project-relative file. */
  stage(relPath: string, content: string): void {
    this.stageBytes(relPath, Buffer.from(content, 'utf8'));
  }

  /** Stage the full final bytes of one project-relative regular file. */
  stageBytes(relPath: string, content: Buffer, mode = 0o644): void {
    const normalized = normalizeTxnPath(relPath);
    const staged = path.join(this.dir, 'staged', normalized);
    writeDurableAtomic(staged, content, mode);
    this.setOperation({
      type: 'file',
      path: normalized,
      sha256: sha256(content),
      size: content.byteLength,
      mode: mode & 0o777,
    });
    this.receipt(`staged:${normalized}`);
    this.hooks.afterWrite?.(`stage:${normalized}`);
  }

  /** Record a path that must not exist in the final project tree. */
  stageDelete(relPath: string): void {
    const normalized = normalizeTxnPath(relPath);
    this.setOperation({ type: 'delete', path: normalized });
    this.receipt(`delete:${normalized}`);
    this.hooks.afterWrite?.(`delete:${normalized}`);
  }

  /** Record a relative, project-contained symbolic link as explicit intent. */
  stageSymlink(relPath: string, target: string): void {
    const normalized = normalizeTxnPath(relPath);
    assertSafeSymlink(this.projectRoot, normalized, target);
    this.setOperation({ type: 'symlink', path: normalized, target });
    this.receipt(`symlink:${normalized}`);
    this.hooks.afterWrite?.(`symlink:${normalized}`);
  }

  /** Record a directory that must exist in the final state. */
  stageDir(relPath: string): void {
    const normalized = normalizeTxnPath(relPath);
    this.setOperation({ type: 'directory', path: normalized });
    this.receipt(`dir:${normalized}`);
    this.hooks.afterWrite?.(`dir:${normalized}`);
  }

  /**
   * Write the durable operation document and then the atomic commit marker.
   * The project tree remains unchanged until the marker exists.
   */
  commitPoint(): void {
    const document: OperationDocument = {
      version: 2,
      operations: orderOperations(this.operations.values()),
    };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    writeDurableAtomic(path.join(this.dir, 'operations.json'), serialized);
    this.receipt('operations-written');
    this.hooks.afterWrite?.('operations');

    const marker: CommitMarkerV2 = {
      version: 2,
      operations_sha256: sha256(serialized),
      committed_at: new Date().toISOString(),
    };
    writeDurableAtomic(path.join(this.dir, 'commit.json'), `${JSON.stringify(marker, null, 2)}\n`);
    this.receipt('commit-point');
    this.hooks.afterWrite?.('commit');
  }

  /** Apply the committed state to the project tree. */
  apply(): string[] {
    return applyStaged(this.dir, this.projectRoot, this.hooks);
  }

  /** Mark the transaction complete and remove its staging directory. */
  finish(): void {
    writeDurableAtomic(path.join(this.dir, 'done'), 'done\n');
    this.receipt('done');
    this.hooks.afterWrite?.('finish');
    fs.rmSync(this.dir, { recursive: true, force: true });
    fsyncDirectory(path.dirname(this.dir));
  }
}

function listStaged(dir: string): string[] {
  const stagedRoot = path.join(dir, 'staged');
  if (!exists(stagedRoot)) return [];
  const output: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else output.push(path.relative(stagedRoot, full).split(path.sep).join('/'));
    }
  };
  walk(stagedRoot);
  return output.sort();
}

function readV2Operations(dir: string): TxnOperation[] | null {
  const operationsPath = path.join(dir, 'operations.json');
  if (!exists(operationsPath)) return null;
  const serialized = fs.readFileSync(operationsPath, 'utf8');
  const commit = JSON.parse(fs.readFileSync(path.join(dir, 'commit.json'), 'utf8')) as Partial<CommitMarkerV2>;
  if (commit.version !== 2 || commit.operations_sha256 !== sha256(serialized)) {
    throw new Error(`Transaction operation integrity check failed: ${path.basename(dir)}`);
  }
  const document = JSON.parse(serialized) as Partial<OperationDocument>;
  if (document.version !== 2 || !Array.isArray(document.operations)) {
    throw new Error(`Transaction operation document is invalid: ${path.basename(dir)}`);
  }

  const seen = new Set<string>();
  const operations: TxnOperation[] = [];
  for (const raw of document.operations as Array<Partial<TxnOperation>>) {
    if (
      raw.type !== 'directory' &&
      raw.type !== 'delete' &&
      raw.type !== 'file' &&
      raw.type !== 'symlink'
    ) {
      throw new Error(`Transaction operation type is invalid: ${path.basename(dir)}`);
    }
    const normalized = normalizeTxnPath(String(raw.path ?? ''));
    if (normalized !== raw.path || seen.has(normalized)) {
      throw new Error(`Transaction operation path is duplicate or invalid: ${String(raw.path)}`);
    }
    seen.add(normalized);
    if (raw.type === 'file') {
      if (
        typeof raw.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.sha256) ||
        !Number.isSafeInteger(raw.size) ||
        Number(raw.size) < 0 ||
        !Number.isInteger(raw.mode)
      ) {
        throw new Error(`Transaction file operation is invalid: ${normalized}`);
      }
      operations.push({
        type: 'file',
        path: normalized,
        sha256: raw.sha256,
        size: Number(raw.size),
        mode: Number(raw.mode) & 0o777,
      });
    } else if (raw.type === 'symlink') {
      if (typeof raw.target !== 'string') {
        throw new Error(`Transaction symlink operation is invalid: ${normalized}`);
      }
      operations.push({ type: 'symlink', path: normalized, target: raw.target });
    } else {
      operations.push({ type: raw.type, path: normalized });
    }
  }
  return operations;
}

function removeDestination(projectRoot: string, rel: string): void {
  assertNoSymlinkParent(projectRoot, rel);
  const destination = path.join(projectRoot, rel);
  fs.rmSync(destination, { recursive: true, force: true });
  fsyncDirectory(path.dirname(destination));
}

function installFile(
  dir: string,
  projectRoot: string,
  operation: FileOperation,
  hooks: TxnHooks,
): void {
  assertNoSymlinkParent(projectRoot, operation.path);
  const staged = path.join(dir, 'staged', operation.path);
  assertNoSymlinkParent(path.join(dir, 'staged'), operation.path);
  const stat = fs.lstatSync(staged);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Transaction staged file is not regular: ${operation.path}`);
  }
  const content = fs.readFileSync(staged);
  if (content.byteLength !== operation.size || sha256(content) !== operation.sha256) {
    throw new Error(`Transaction staged file integrity check failed: ${operation.path}`);
  }
  const destination = path.join(projectRoot, operation.path);
  ensureDir(path.dirname(destination));
  if (exists(destination) && fs.lstatSync(destination).isDirectory()) {
    fs.rmSync(destination, { recursive: true, force: true });
  }
  const temporary = projectTempName(destination, path.basename(dir), operation.path);
  fs.rmSync(temporary, { recursive: true, force: true });
  const fd = fs.openSync(temporary, 'wx', operation.mode);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, operation.mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  hooks.afterWrite?.(`apply-pre-rename:file:${operation.path}`);
  try {
    fs.renameSync(temporary, destination);
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function installSymlink(
  dir: string,
  projectRoot: string,
  operation: SymlinkOperation,
  hooks: TxnHooks,
): void {
  assertNoSymlinkParent(projectRoot, operation.path);
  assertSafeSymlink(projectRoot, operation.path, operation.target);
  const destination = path.join(projectRoot, operation.path);
  ensureDir(path.dirname(destination));
  if (exists(destination) || isSymbolicLink(destination)) {
    fs.rmSync(destination, { recursive: true, force: true });
  }
  const temporary = projectTempName(destination, path.basename(dir), operation.path);
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.symlinkSync(operation.target, temporary);
  hooks.afterWrite?.(`apply-pre-rename:symlink:${operation.path}`);
  try {
    fs.renameSync(temporary, destination);
    fsyncDirectory(path.dirname(destination));
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function validateOperationSet(dir: string, projectRoot: string, operations: TxnOperation[]): void {
  const symlinkPaths = new Set(
    operations.filter((operation): operation is SymlinkOperation => operation.type === 'symlink').map((operation) => operation.path),
  );
  for (const operation of operations) {
    assertNoSymlinkParent(projectRoot, operation.path);
    if (operation.type === 'symlink') assertSafeSymlink(projectRoot, operation.path, operation.target);
    for (const symlinkPath of symlinkPaths) {
      if (operation.path.startsWith(`${symlinkPath}/`)) {
        throw new Error(`Transaction operation would traverse a staged symbolic link: ${operation.path}`);
      }
    }
    if (operation.type === 'file') {
      const staged = path.join(dir, 'staged', operation.path);
      assertNoSymlinkParent(path.join(dir, 'staged'), operation.path);
      const stat = fs.lstatSync(staged);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Transaction staged file is not regular: ${operation.path}`);
      }
      const content = fs.readFileSync(staged);
      if (content.byteLength !== operation.size || sha256(content) !== operation.sha256) {
        throw new Error(`Transaction staged file integrity check failed: ${operation.path}`);
      }
    }
  }
}

function isSymbolicLink(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

function applyV2Operations(
  dir: string,
  projectRoot: string,
  operations: TxnOperation[],
  hooks: TxnHooks,
): string[] {
  validateOperationSet(dir, projectRoot, operations);
  const applied: string[] = [];
  const deletes = operations
    .filter((operation): operation is DeleteOperation => operation.type === 'delete')
    .sort((left, right) => right.path.split('/').length - left.path.split('/').length || left.path.localeCompare(right.path));
  const directories = operations
    .filter((operation): operation is DirectoryOperation => operation.type === 'directory')
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));
  const writes = operations
    .filter((operation): operation is FileOperation | SymlinkOperation => operation.type === 'file' || operation.type === 'symlink')
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const operation of deletes) {
    removeDestination(projectRoot, operation.path);
    applied.push(operation.path);
    hooks.afterWrite?.(`apply:delete:${operation.path}`);
  }
  for (const operation of directories) {
    assertNoSymlinkParent(projectRoot, operation.path);
    ensureDir(path.join(projectRoot, operation.path));
    fsyncDirectory(path.dirname(path.join(projectRoot, operation.path)));
    applied.push(operation.path);
    hooks.afterWrite?.(`apply:directory:${operation.path}`);
  }
  for (const operation of writes) {
    if (operation.type === 'file') installFile(dir, projectRoot, operation, hooks);
    else installSymlink(dir, projectRoot, operation, hooks);
    applied.push(operation.path);
    hooks.afterWrite?.(`apply:${operation.type}:${operation.path}`);
  }
  return applied;
}

/** Compatibility apply for transactions committed before operation documents existed. */
function applyLegacyStaged(dir: string, projectRoot: string, hooks: TxnHooks): string[] {
  const applied: string[] = [];
  const dirsList = path.join(dir, 'dirs.list');
  if (exists(dirsList)) {
    for (const rel of fs.readFileSync(dirsList, 'utf8').split('\n').filter(Boolean)) {
      const normalized = normalizeTxnPath(rel);
      assertNoSymlinkParent(projectRoot, normalized);
      ensureDir(path.join(projectRoot, normalized));
    }
  }
  for (const rel of listStaged(dir)) {
    const normalized = normalizeTxnPath(rel);
    const source = path.join(dir, 'staged', normalized);
    const content = fs.readFileSync(source);
    const mode = fs.statSync(source).mode & 0o777;
    installFile(
      dir,
      projectRoot,
      {
        type: 'file',
        path: normalized,
        sha256: sha256(content),
        size: content.byteLength,
        mode,
      },
      hooks,
    );
    applied.push(normalized);
    hooks.afterWrite?.(`apply:${normalized}`);
  }
  return applied;
}

function applyStaged(dir: string, projectRoot: string, hooks: TxnHooks = {}): string[] {
  const operations = readV2Operations(dir);
  return operations === null
    ? applyLegacyStaged(dir, projectRoot, hooks)
    : applyV2Operations(dir, projectRoot, operations, hooks);
}

export interface ReconcileReport {
  rolledForward: string[];
  rolledBack: string[];
}

/**
 * Roll back uncommitted staging. Roll committed transactions forward. A failed
 * roll-forward remains on disk so the next startup can retry it.
 */
export function reconcileTransactions(paths: RijoPaths): ReconcileReport {
  const report: ReconcileReport = { rolledForward: [], rolledBack: [] };
  const transactionRoot = path.join(paths.runtimeDir, 'transactions');
  if (!exists(transactionRoot)) return report;
  for (const entry of fs.readdirSync(transactionRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(transactionRoot, entry.name);
    if (exists(path.join(dir, 'commit.json'))) {
      applyStaged(dir, paths.projectRoot);
      report.rolledForward.push(entry.name);
    } else {
      report.rolledBack.push(entry.name);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fsyncDirectory(transactionRoot);
  }
  return report;
}
