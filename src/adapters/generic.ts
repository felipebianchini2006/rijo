import * as path from 'node:path';
import { upsertMarkerFile, rijoInstructionBlock, type AdapterReport } from './shared.js';

/** Generic adapter: only the idempotent AGENTS.md block. */
export function generateGenericAdapter(projectRoot: string): AdapterReport {
  upsertMarkerFile(path.join(projectRoot, 'AGENTS.md'), rijoInstructionBlock());
  return { generated: ['AGENTS.md (RIJO block)'], skipped: [], notes: [] };
}
