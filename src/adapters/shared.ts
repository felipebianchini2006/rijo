import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainedWithoutSymlinks, exists, readTextIfExists, writeFileAtomic } from '../core/fsx.js';

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

/** Validate every existing provider destination segment before installation. */
export function assertProviderDestinationsSafe(root: string, destinations: string[]): void {
  for (const destination of destinations) {
    assertContainedWithoutSymlinks(root, destination);
  }
}

/** The canonical instruction block injected into CLAUDE.md / AGENTS.md. */
export function rijoInstructionBlock(): string {
  return [
    'RIJO project memory is in `.rijo/`.',
    '',
    '1. Use `$rijo` for RIJO work in Codex. Use `/rijo` for RIJO work in Claude Code.',
    '2. Read `.rijo/STATE.md` first when it exists.',
    '3. Use `node .rijo/bin/rijo.cjs` for every deterministic RIJO helper.',
    '4. Do not resolve `rijo` from the global PATH during a native workflow.',
    '5. Load only the active phase context.',
    '6. Read `.rijo/RULES.md` before you change project files.',
    '7. Use the codebase summary before you open detailed codebase map files.',
    '8. Delegate bounded work to native subagents.',
    '9. Create a durable task record before each delegation.',
    '10. Record each native subagent result or failure.',
    '11. Use worktree isolation for implementation writers when the host supports it.',
    '12. Do not run `codex exec` from the native workflow.',
    '13. Do not run `claude -p` from the native workflow.',
    '14. Do not start a nested host process.',
    '15. Do not claim completion without evidence.',
    '16. Use deterministic RIJO helper commands only for state, validation, evidence, checkpoints, and recovery.',
    '17. Resolve reversible technical decisions with `.rijo/config.yml` and `.rijo/DECISIONS.md`.',
    '18. Use English for every RIJO host message and generated artifact.',
    '19. Never use Portuguese during a RIJO workflow.',
  ].join('\n');
}

/** Compatibility export for callers that still import the old helper. */
export function hostBridgeNote(): string {
  return [
    'The active Codex or Claude Code session is the RIJO orchestrator.',
    'Use native subagents for delegated work.',
    'Do not start another host process from a native RIJO workflow.',
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
  const canonical = path.join(packageRoot(), 'skills', name, 'SKILL.md');
  if (exists(canonical)) return readTextIfExists(canonical);
  const legacy = path.join(packageRoot(), 'skills', `${name}.md`);
  return exists(legacy) ? readTextIfExists(legacy) : null;
}

/** Copy the canonical skill tree without following links or reading outside it. */
export function installCanonicalSkill(destination: string): string[] {
  const sourceRoot = path.join(packageRoot(), 'skills', 'rijo');
  if (!exists(path.join(sourceRoot, 'SKILL.md'))) {
    throw new Error('The canonical RIJO skill is missing from the package.');
  }

  const generated: string[] = [];
  const copy = (sourceDir: string, destinationDir: string): void => {
    const entries = [...requireDirectoryEntries(sourceDir)].sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const source = path.join(sourceDir, entry.name);
      const target = path.join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        copy(source, target);
      } else if (entry.isFile()) {
        const content = readTextIfExists(source);
        if (content === null) throw new Error(`Skill source disappeared during installation: ${source}`);
        writeFileAtomic(target, content);
        generated.push(target);
      }
    }
  };
  copy(sourceRoot, destination);
  return generated;
}

function requireDirectoryEntries(directory: string): import('node:fs').Dirent[] {
  // Importing through the namespace keeps this helper synchronous like fsx.
  return fs.readdirSync(directory, { withFileTypes: true });
}

export interface AdapterReport {
  generated: string[];
  skipped: string[];
  notes: string[];
}
