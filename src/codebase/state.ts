import { z } from 'zod';
import * as fs from 'node:fs';
import type { RijoPaths } from '../core/paths.js';
import { readJsonIfExists, writeJsonAtomic } from '../core/fsx.js';
import { MapStateSchema, type CodebaseMapState } from './schemas.js';

const StaleMarkerSchema = z.object({
  changed_paths: z.array(z.string()),
  reasons: z.array(z.string()),
  marked_at: z.string(),
});

export function readMapState(paths: RijoPaths): CodebaseMapState | null {
  const raw = readJsonIfExists<unknown>(paths.codebaseMapState);
  if (raw === null) return null;
  const parsed = MapStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function readStaleMarker(paths: RijoPaths): z.infer<typeof StaleMarkerSchema> | null {
  const parsed = StaleMarkerSchema.safeParse(readJsonIfExists<unknown>(paths.codebaseStale));
  return parsed.success ? parsed.data : null;
}

export function markCodebasePathsStale(
  paths: RijoPaths,
  changedPaths: string[],
  reason: string,
  now: () => Date = () => new Date(),
): void {
  if (!readMapState(paths) || changedPaths.length === 0) return;
  const previous = readStaleMarker(paths);
  writeJsonAtomic(paths.codebaseStale, {
    changed_paths: [...new Set([...(previous?.changed_paths ?? []), ...changedPaths])].sort(),
    reasons: [...new Set([...(previous?.reasons ?? []), reason])],
    marked_at: now().toISOString(),
  });
}

export function clearStaleMarker(paths: RijoPaths): void {
  fs.rmSync(paths.codebaseStale, { force: true });
}
