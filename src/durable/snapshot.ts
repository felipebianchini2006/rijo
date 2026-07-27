import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/fsx.js';
import { canonicalJson, redactDurableValue, sha256 } from './canonical.js';
import type {
  DurableSnapshot,
  SnapshotBuildInput,
  StateStore,
} from './types.js';

export interface WrittenSnapshot {
  path: string;
  latest: string;
  hash: string;
  sequence: number;
}

export async function buildDurableSnapshot(
  store: StateStore,
  input: SnapshotBuildInput,
): Promise<DurableSnapshot> {
  const snapshot = await store.exportSnapshot(input);
  return redactDurableValue(snapshot) as DurableSnapshot;
}

export function writeDurableSnapshot(
  projectRoot: string,
  raw: DurableSnapshot,
): WrittenSnapshot {
  const snapshot = redactDurableValue(raw) as DurableSnapshot;
  const canonical = `${canonicalJson(snapshot)}\n`;
  const hash = sha256(canonical);
  const snapshotsDir = path.join(projectRoot, '.rijo', 'ledger', 'snapshots');
  const target = path.join(snapshotsDir, `${snapshot.last_sequence}-${hash}.json`);
  const latest = path.join(projectRoot, '.rijo', 'ledger', 'latest.json');
  writeFileAtomic(target, canonical);
  writeFileAtomic(latest, canonical);
  verifyFileHash(target, hash);
  verifyFileHash(latest, hash);
  return { path: target, latest, hash, sequence: snapshot.last_sequence };
}

export function readLatestSnapshot(projectRoot: string): DurableSnapshot | null {
  const latest = path.join(projectRoot, '.rijo', 'ledger', 'latest.json');
  if (!fs.existsSync(latest)) return null;
  const parsed = JSON.parse(fs.readFileSync(latest, 'utf8')) as DurableSnapshot;
  if (!hasSnapshotShape(parsed)) {
    throw new Error('Latest durable snapshot has an invalid shape');
  }
  return parsed;
}

export function readNewestValidSnapshot(projectRoot: string): DurableSnapshot | null {
  const snapshotsDir = path.join(projectRoot, '.rijo', 'ledger', 'snapshots');
  if (!fs.existsSync(snapshotsDir)) return null;
  const candidates = fs
    .readdirSync(snapshotsDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const match = entry.match(/^(\d+)-([a-f0-9]{64})\.json$/);
      if (!match) return null;
      const target = path.join(snapshotsDir, entry);
      const verified = verifySnapshotFile(target);
      if (
        !verified.valid ||
        !verified.snapshot ||
        verified.hash !== match[2] ||
        verified.snapshot.last_sequence !== Number(match[1])
      ) {
        return null;
      }
      return verified.snapshot;
    })
    .filter((snapshot): snapshot is DurableSnapshot => snapshot !== null)
    .sort(
      (left, right) =>
        right.last_sequence - left.last_sequence ||
        right.generated_at.localeCompare(left.generated_at),
    );
  return candidates[0] ?? null;
}

export function verifySnapshotFile(target: string): {
  valid: boolean;
  hash: string;
  snapshot: DurableSnapshot | null;
} {
  try {
    const content = fs.readFileSync(target, 'utf8');
    const snapshot = JSON.parse(content) as DurableSnapshot;
    if (!hasSnapshotShape(snapshot)) return { valid: false, hash: '', snapshot: null };
    const canonical = `${canonicalJson(snapshot)}\n`;
    const hash = sha256(canonical);
    return { valid: content === canonical, hash, snapshot };
  } catch {
    return { valid: false, hash: '', snapshot: null };
  }
}

export function collectCanonicalArtifactHashes(
  projectRoot: string,
): Record<string, string> {
  const root = path.join(projectRoot, '.rijo');
  if (!fs.existsSync(root)) return {};
  const hashes: Record<string, string> = {};
  const skip = new Set(['runtime', 'state', 'ledger']);
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(dir, entry.name);
      const relative = path.relative(root, target).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(target);
        continue;
      }
      // events.jsonl is a rebuildable live projection that can legitimately
      // advance beyond a snapshot. Its integrity is covered by the event hash
      // chain and finalized segments, so it must not be treated as immutable.
      if (entry.isFile() && relative !== 'events.jsonl') {
        hashes[relative] = sha256(fs.readFileSync(target));
      }
    }
  };
  walk(root);
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function verifyFileHash(target: string, expected: string): void {
  const actual = sha256(fs.readFileSync(target));
  if (actual !== expected) throw new Error(`Snapshot hash verification failed for ${target}`);
}

function hasSnapshotShape(snapshot: DurableSnapshot): boolean {
  return (
    typeof snapshot.schema_version === 'number' &&
    typeof snapshot.last_sequence === 'number' &&
    typeof snapshot.last_event_hash === 'string' &&
    typeof snapshot.generated_at === 'string' &&
    Array.isArray(snapshot.milestones) &&
    Array.isArray(snapshot.phases) &&
    Array.isArray(snapshot.requirements) &&
    Array.isArray(snapshot.tasks) &&
    Array.isArray(snapshot.decisions) &&
    Array.isArray(snapshot.command_evidence) &&
    Array.isArray(snapshot.attempts) &&
    Array.isArray(snapshot.leases) &&
    Array.isArray(snapshot.process_receipts) &&
    Array.isArray(snapshot.recovery_receipts) &&
    Array.isArray(snapshot.checkpoints) &&
    Array.isArray(snapshot.outbox_pending)
  );
}
