import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDurableGitignore } from './ignore.js';
import { DurableOutboxProjector } from './projector.js';
import { readEventSegments } from './segments.js';
import {
  readNewestValidSnapshot,
  readLatestSnapshot,
  verifySnapshotFile,
  writeDurableSnapshot,
} from './snapshot.js';
import type { DurableSnapshot } from './types.js';
import { sha256 } from './canonical.js';
import {
  SqliteStateStore,
  type SqliteStateStoreOptions,
} from './sqliteStore.js';

export interface DurableRecoveryResult {
  store: SqliteStateStore;
  rebuilt: boolean;
  projected: number;
  diagnostic_database: string | null;
}

export async function recoverSqliteState(
  options: SqliteStateStoreOptions,
): Promise<DurableRecoveryResult> {
  const projectRoot = path.resolve(options.projectRoot);
  ensureDurableGitignore(projectRoot);
  const dbPath = options.dbPath ?? path.join(projectRoot, '.rijo', 'state', 'rijo.db');
  const existed = fs.existsSync(dbPath);
  const portable = resolvePortableSnapshot(projectRoot);
  const portableSnapshot = portable.snapshot;
  if (!existed && portableSnapshot) {
    if (portable.fromFallback) writeDurableSnapshot(projectRoot, portableSnapshot);
    else validateLatestIfPresent(projectRoot);
    verifyPortableContext(projectRoot, portableSnapshot);
    const posteriorEvents = readEventSegments(projectRoot, portableSnapshot.last_sequence);
    const rebuiltStore = new SqliteStateStore(options);
    try {
      await rebuiltStore.initialize();
      await rebuiltStore.rebuild(portableSnapshot, posteriorEvents);
      const projected = await new DurableOutboxProjector(projectRoot, rebuiltStore).flush();
      return {
        store: rebuiltStore,
        rebuilt: true,
        projected,
        diagnostic_database: null,
      };
    } catch (error) {
      await safeClose(rebuiltStore);
      throw error;
    }
  }
  let store = new SqliteStateStore(options);
  try {
    await store.initialize();
  } catch (initialError) {
    await safeClose(store);
    if (!existed) throw initialError;

    const diagnostic = preserveInvalidDatabase(dbPath);
    const snapshot = portableSnapshot ?? readNewestValidSnapshot(projectRoot);
    if (!snapshot) {
      throw new Error(
        `Durable database was preserved at ${diagnostic}, but no valid latest snapshot is available for rebuild.`,
      );
    }
    if (portable.fromFallback) writeDurableSnapshot(projectRoot, snapshot);
    else validateLatestIfPresent(projectRoot);
    verifyPortableContext(projectRoot, snapshot);
    const events = readEventSegments(projectRoot, snapshot.last_sequence);
    store = new SqliteStateStore(options);
    try {
      await store.initialize();
      await store.rebuild(snapshot, events);
      const projected = await new DurableOutboxProjector(projectRoot, store).flush();
      return {
        store,
        rebuilt: true,
        projected,
        diagnostic_database: diagnostic,
      };
    } catch (rebuildError) {
      await safeClose(store);
      throw new Error(
        `Durable state rebuild failed after preserving ${diagnostic}: ${
          rebuildError instanceof Error ? rebuildError.message : String(rebuildError)
        }`,
      );
    }
  }
  // A healthy database is never renamed merely because a portable projection
  // or outbox destination is invalid. Those failures are surfaced separately.
  try {
    validateLatestIfPresent(projectRoot);
    if (portableSnapshot) {
      const integrity = await store.integrityCheck();
      if (portableSnapshot.last_sequence > integrity.last_event_sequence) {
        throw new Error(
          `Portable snapshot sequence ${portableSnapshot.last_sequence} is ahead of ledger sequence ${integrity.last_event_sequence}`,
        );
      }
      verifyPortableContext(
        projectRoot,
        portableSnapshot,
        portableSnapshot.last_sequence === integrity.last_event_sequence,
      );
    }
    const projected = await new DurableOutboxProjector(projectRoot, store).flush();
    return { store, rebuilt: false, projected, diagnostic_database: null };
  } catch (projectionError) {
    await safeClose(store);
    throw projectionError;
  }
}

function verifyPortableContext(
  projectRoot: string,
  snapshot: DurableSnapshot,
  verifyArtifactHashes = true,
): void {
  for (const [relative, expected] of verifyArtifactHashes
    ? Object.entries(snapshot.artifact_hashes)
    : []) {
    // Compatibility with snapshots written before events.jsonl was correctly
    // classified as a mutable, rebuildable projection.
    if (relative === 'events.jsonl') {
      verifyEventProjectionAnchor(projectRoot, snapshot);
      continue;
    }
    const target = path.resolve(projectRoot, '.rijo', relative);
    const root = path.resolve(projectRoot, '.rijo');
    const rel = path.relative(root, target);
    if (path.isAbsolute(rel) || rel.startsWith('..') || !fs.existsSync(target)) {
      throw new Error(`Snapshot artifact is missing or escapes .rijo: ${relative}`);
    }
    const actual = sha256(fs.readFileSync(target));
    if (actual !== expected) {
      throw new Error(`Snapshot artifact hash mismatch: ${relative}`);
    }
  }
  if (!snapshot.git_commit) return;
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return;
  const commit = spawnSync(
    'git',
    ['cat-file', '-e', `${snapshot.git_commit}^{commit}`],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  if (commit.status !== 0) {
    throw new Error(`Snapshot Git commit is unavailable: ${snapshot.git_commit}`);
  }
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', snapshot.git_commit, 'HEAD'],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  if (ancestor.status !== 0) {
    throw new Error(
      `Snapshot Git commit ${snapshot.git_commit} is not an ancestor of HEAD`,
    );
  }
}

function verifyEventProjectionAnchor(
  projectRoot: string,
  snapshot: DurableSnapshot,
): void {
  if (snapshot.last_sequence === 0) return;
  const projection = path.join(projectRoot, '.rijo', 'events.jsonl');
  if (!fs.existsSync(projection)) return;
  const event = fs
    .readFileSync(projection, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { sequence?: number; event_hash?: string })
    .find((candidate) => candidate.sequence === snapshot.last_sequence);
  if (!event || event.event_hash !== snapshot.last_event_hash) {
    throw new Error(
      `Snapshot event projection anchor mismatch at sequence ${snapshot.last_sequence}`,
    );
  }
}

function resolvePortableSnapshot(projectRoot: string): {
  snapshot: DurableSnapshot | null;
  fromFallback: boolean;
} {
  try {
    validateLatestIfPresent(projectRoot);
    return { snapshot: readLatestSnapshot(projectRoot), fromFallback: false };
  } catch {
    return {
      snapshot: readNewestValidSnapshot(projectRoot),
      fromFallback: true,
    };
  }
}

function validateLatestIfPresent(projectRoot: string): void {
  const target = path.join(projectRoot, '.rijo', 'ledger', 'latest.json');
  if (!fs.existsSync(target)) return;
  const verified = verifySnapshotFile(target);
  if (!verified.valid || !verified.snapshot) {
    throw new Error('Latest durable snapshot is invalid or non-canonical');
  }
  const immutable = path.join(
    projectRoot,
    '.rijo',
    'ledger',
    'snapshots',
    `${verified.snapshot.last_sequence}-${verified.hash}.json`,
  );
  const immutableVerification = verifySnapshotFile(immutable);
  if (
    !immutableVerification.valid ||
    immutableVerification.hash !== verified.hash
  ) {
    throw new Error('Latest durable snapshot does not match an immutable hashed snapshot');
  }
}

function preserveInvalidDatabase(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const diagnostic = `${dbPath}.corrupt-${stamp}`;
  fs.renameSync(dbPath, diagnostic);
  for (const suffix of ['-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (fs.existsSync(source)) fs.renameSync(source, `${diagnostic}${suffix}`);
  }
  return diagnostic;
}

async function safeClose(store: SqliteStateStore): Promise<void> {
  try {
    await store.close();
  } catch {
    // The database itself may be unreadable. Preservation happens next.
  }
}
