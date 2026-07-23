import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readTextIfExists, writeFileAtomic } from '../core/fsx.js';

export const BEGIN = '<!-- RIJO:BEGIN -->';
export const END = '<!-- RIJO:END -->';

/**
 * Idempotent marker-block upsert: RIJO only ever edits the region between its
 * markers; manual content outside the block is preserved byte-for-byte.
 */
export function upsertMarkerBlock(existing: string | null, blockBody: string): string {
  const block = `${BEGIN}\n${blockBody.trim()}\n${END}`;
  if (existing === null || existing.trim() === '') return block + '\n';
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  return existing.trimEnd() + '\n\n' + block + '\n';
}

export function upsertMarkerFile(filePath: string, blockBody: string): void {
  writeFileAtomic(filePath, upsertMarkerBlock(readTextIfExists(filePath), blockBody));
}

/** The canonical instruction block injected into CLAUDE.md / AGENTS.md. */
export function rijoInstructionBlock(): string {
  return [
    '1. Leia `.rijo/STATE.md`.',
    '2. Leia `.rijo/RULES.md`.',
    '3. Leia a `SPEC.md` e a `PLAN.md` da fase ativa.',
    '4. Carregue `.rijo/PROJECT.md`, `.rijo/STACK.md` e o `REQUIREMENTS.md` do milestone ativo somente quando a tarefa exigir.',
    '5. Não marque trabalho como concluído sem evidência.',
    '6. Após uma tarefa verificada, atualize o estado por meio do protocolo RIJO (CLI `rijo`).',
  ].join('\n');
}

/** Root of the installed rijo package (dist/adapters/shared.js -> ../..). */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/adapters or src/adapters — package root is two levels up
  return path.resolve(here, '..', '..');
}

/** Load a canonical skill source shipped with the package. */
export function loadSkillSource(name: string): string | null {
  const p = path.join(packageRoot(), 'skills', `${name}.md`);
  return exists(p) ? readTextIfExists(p) : null;
}

export interface AdapterReport {
  generated: string[];
  skipped: string[];
  notes: string[];
}
