import * as fs from 'node:fs';
import { loadConfig } from '../core/config.js';
import { exists, readJson, writeJsonAtomic } from '../core/fsx.js';
import { SystemGit, type GitOps } from '../core/git.js';
import { RijoPaths } from '../core/paths.js';
import { snapshotFiles, type FileSnapshot } from '../core/scope.js';

const QA_CHECKPOINT_VERSION = 1;
const SNAPSHOT_SKIP_DIRS = ['node_modules', '.git', 'dist', '.next', 'coverage'];
const VOLATILE_PREFIXES = ['.rijo/runtime/', '.rijo/state/', '.rijo/archive/'];

export interface QaCheckpoint {
  version: 1;
  opened_at: string;
  initial_head: string | null;
  initial_dirty_files: string[];
  files: Record<string, string>;
  tested_commit: string | null;
}

export interface QaCheckpointOpenResult {
  resumed: boolean;
  checkpoint: QaCheckpoint;
}

/** Capture the clean project state before native product QA can change files. */
export function openQaCheckpoint(
  projectRoot: string,
  git: GitOps = new SystemGit(),
  now: () => Date = () => new Date(),
): QaCheckpointOpenResult {
  const paths = new RijoPaths(projectRoot);
  if (!exists(paths.manifest)) {
    throw new Error('No RIJO project exists. Run `$rijo new @PLAN.md` first.');
  }
  if (exists(paths.qaCheckpoint)) {
    return { resumed: true, checkpoint: readQaCheckpoint(paths)! };
  }

  const status = git.status(projectRoot);
  if (status.isRepo && loadConfig(paths).git.commit && status.dirtyFiles.length > 0) {
    throw new Error(`The working tree must be clean before product QA. Dirty files: ${status.dirtyFiles.join(', ')}`);
  }

  const checkpoint: QaCheckpoint = {
    version: QA_CHECKPOINT_VERSION,
    opened_at: now().toISOString(),
    initial_head: git.headCommit(projectRoot),
    initial_dirty_files: status.dirtyFiles,
    files: Object.fromEntries(portableQaSnapshot(projectRoot)),
    tested_commit: null,
  };
  writeJsonAtomic(paths.qaCheckpoint, checkpoint);
  return { resumed: false, checkpoint };
}

export function readQaCheckpoint(paths: RijoPaths): QaCheckpoint | null {
  if (!exists(paths.qaCheckpoint)) return null;
  const value = readJson<Partial<QaCheckpoint>>(paths.qaCheckpoint);
  if (
    value.version !== QA_CHECKPOINT_VERSION ||
    typeof value.opened_at !== 'string' ||
    !Array.isArray(value.initial_dirty_files) ||
    !value.files ||
    typeof value.files !== 'object'
  ) {
    throw new Error('The native QA checkpoint is invalid. Run `$rijo resume`.');
  }
  return {
    version: QA_CHECKPOINT_VERSION,
    opened_at: value.opened_at,
    initial_head: typeof value.initial_head === 'string' ? value.initial_head : null,
    initial_dirty_files: value.initial_dirty_files,
    files: value.files,
    tested_commit: typeof value.tested_commit === 'string' ? value.tested_commit : null,
  };
}

export function writeQaCheckpoint(paths: RijoPaths, checkpoint: QaCheckpoint): void {
  writeJsonAtomic(paths.qaCheckpoint, checkpoint);
}

export function clearQaCheckpoint(paths: RijoPaths): void {
  fs.rmSync(paths.qaCheckpoint, { force: true });
}

/** Hash portable source and evidence files. Exclude local RIJO runtime state. */
export function portableQaSnapshot(projectRoot: string): FileSnapshot {
  const snapshot = snapshotFiles(projectRoot, SNAPSHOT_SKIP_DIRS);
  for (const file of snapshot.keys()) {
    if (VOLATILE_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      snapshot.delete(file);
    }
  }
  return snapshot;
}
