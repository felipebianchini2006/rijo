import * as fs from 'node:fs';
import { z } from 'zod';
import { exists, readJsonIfExists, writeJsonAtomic } from './fsx.js';
import type { RijoPaths } from './paths.js';

/**
 * Durable, resumable phase-finalization marker.
 *
 * Phase finalization (turn a VERIFIED phase into a committed, DONE phase) is a
 * multi-step sequence: write candidate artifacts → C1 (code+state) → evidence
 * metadata → C2 → seal → flip requirements/roadmap/checkpoint to DONE. If the
 * process dies between any two of those steps the tree can end up half-sealed.
 *
 * This marker, written to `.rijo/runtime/finalize.json` with an fsync'd atomic
 * write BEFORE any DONE status or commit is produced, records exactly what the
 * finalization must accomplish and how far it got (the C1/C2 hashes and the
 * `sealed` flag are the real progress ledger). While the marker exists the
 * phase is "finalizing" and its on-disk DONE status is NOT authoritative —
 * every subsequent execution resumes the finalization from where it stopped and
 * only when the sequence is complete is the marker removed. Removal IS the
 * completion signal, so a crash is always observable as either the fully
 * pre-finalization state or the fully DONE-and-committed state — never a DONE
 * phase without its commits.
 */

export const FinalizeStepSchema = z.enum(['STAGED', 'C1', 'C2', 'SEALED']);
export type FinalizeStep = z.infer<typeof FinalizeStepSchema>;

export const FinalizeMarkerSchema = z.object({
  milestone: z.string(),
  phase: z.string(),
  /** Project-relative phase directory (for auditing; paths are re-derived on resume). */
  phase_dir_rel: z.string(),
  vcs: z.enum(['git', 'disabled']),
  step: FinalizeStepSchema.default('STAGED'),
  /** C1 (code+state) commit — the real "past the point of no return" marker. */
  tested_commit: z.string().nullable().default(null),
  /** C2 (evidence) commit pointing at C1. */
  evidence_commit: z.string().nullable().default(null),
  /** Set once the seal commit has landed; a sealed finalization is idempotently completable. */
  sealed: z.boolean().default(false),
  /** Full C1 path set (authorized source ∪ canonical phase artifacts), project-relative. */
  commit_paths: z.array(z.string()).default([]),
  /** Paths C2 is allowed to touch (evidence metadata only). */
  allowed_evidence_paths: z.array(z.string()).default([]),
  /** Paths the seal commit touches. */
  seal_paths: z.array(z.string()).default([]),
  /** Authorized source subset of commit_paths (for auditing). */
  authorized_source: z.array(z.string()).default([]),
  /** Exact C1 commit message (uniquely identifies our own commit on adoption). */
  commit_message: z.string(),
  created_at: z.string(),
});
export type FinalizeMarker = z.infer<typeof FinalizeMarkerSchema>;

/** Test seam: fault injection at each durable finalization step ("crash here"). */
export interface FinalizeHooks {
  afterStep?: (step: string) => void;
}

/** Build a fresh STAGED marker, applying schema defaults to the progress fields. */
export function buildMarker(
  fields: Pick<
    FinalizeMarker,
    | 'milestone'
    | 'phase'
    | 'phase_dir_rel'
    | 'vcs'
    | 'commit_paths'
    | 'allowed_evidence_paths'
    | 'seal_paths'
    | 'authorized_source'
    | 'commit_message'
    | 'created_at'
  >,
): FinalizeMarker {
  return FinalizeMarkerSchema.parse({ ...fields, step: 'STAGED', tested_commit: null, evidence_commit: null, sealed: false });
}

export function readFinalizeMarker(paths: RijoPaths): FinalizeMarker | null {
  const raw = readJsonIfExists<unknown>(paths.finalize);
  if (raw === null) return null;
  const parsed = FinalizeMarkerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Persist the marker durably (atomic temp+fsync+rename via writeJsonAtomic). */
export function writeFinalizeMarker(paths: RijoPaths, marker: FinalizeMarker): void {
  writeJsonAtomic(paths.finalize, FinalizeMarkerSchema.parse(marker));
}

/** Remove the marker — the single act that declares the finalization complete. */
export function removeFinalizeMarker(paths: RijoPaths): void {
  if (exists(paths.finalize)) fs.rmSync(paths.finalize, { force: true });
}
