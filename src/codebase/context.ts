import * as fs from 'node:fs';
import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { readJsonIfExists, readTextIfExists } from '../core/fsx.js';
import {
  DependencyGraphSchema,
  ClaimsDocumentSchema,
  InventoryDocumentSchema,
  MapStateSchema,
  SurfacesDocumentSchema,
  SymbolsDocumentSchema,
} from './schemas.js';
import type { PhasePlan } from '../core/schemas/index.js';

export interface CodebaseContextPacket {
  text: string;
  bytes: number;
  files_loaded: string[];
  selected_modules: string[];
  freshness: string;
}

export interface PlanMapReferenceIssue {
  code: 'MAP_PATH_NOT_FOUND' | 'MAP_HASH_MISMATCH' | 'MAP_SYMBOL_NOT_FOUND';
  task_id: string;
  message: string;
}

function terms(input: string): Set<string> {
  return new Set(
    input
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9_.:/-]+/)
      .filter((t) => t.length >= 3),
  );
}

function score(text: string, wanted: Set<string>): number {
  const lower = text.toLowerCase();
  let total = 0;
  for (const term of wanted) if (lower.includes(term)) total++;
  return total;
}

function boundedJoin(parts: string[], budget: number): string {
  let out = '';
  for (const part of parts) {
    const candidate = out ? `${out}\n\n${part}` : part;
    if (Buffer.byteLength(candidate) > budget) break;
    out = candidate;
  }
  return out;
}

export function buildContextPacket(projectRoot: string, planText: string, budgetBytes: number): CodebaseContextPacket {
  const paths = new RijoPaths(projectRoot);
  const dir = paths.codebaseDir;
  const loaded: string[] = [];
  const loadText = (name: string): string => {
    const p = path.join(dir, name);
    loaded.push(p);
    return readTextIfExists(p) ?? '';
  };
  const loadJson = <T>(name: string): T | null => {
    const p = path.join(dir, name);
    loaded.push(p);
    return readJsonIfExists<T>(p);
  };

  const summary = loadText('SUMMARY.md');
  const inventoryRaw = loadJson<unknown>('inventory.json');
  const symbolsRaw = loadJson<unknown>('symbols.json');
  const surfacesRaw = loadJson<unknown>('surfaces.json');
  const graphRaw = loadJson<unknown>('dependency-graph.json');
  const stateRaw = loadJson<unknown>('map-state.json');
  const inventory = InventoryDocumentSchema.safeParse(inventoryRaw);
  const symbols = SymbolsDocumentSchema.safeParse(symbolsRaw);
  const surfaces = SurfacesDocumentSchema.safeParse(surfacesRaw);
  const graph = DependencyGraphSchema.safeParse(graphRaw);
  const state = MapStateSchema.safeParse(stateRaw);
  if (!inventory.success || !symbols.success || !surfaces.success || !graph.success || !state.success) {
    const text = boundedJoin(['CODEBASE MAP: unavailable or invalid.', summary], budgetBytes);
    return { text, bytes: Buffer.byteLength(text), files_loaded: loaded, selected_modules: [], freshness: 'invalid' };
  }

  const wanted = terms(planText);
  const moduleScores = new Map<string, number>();
  for (const file of inventory.data.files) {
    const value = score(`${file.path} ${file.module_id} ${file.exports.join(' ')}`, wanted);
    // Planning context must never collapse to a matching plan/doc filename
    // while omitting the application itself. Code modules receive a small
    // structural prior; exact term/surface hits still dominate it.
    const structuralPrior = file.kind === 'code' || file.kind === 'migration' ? 2 : 0;
    moduleScores.set(file.module_id, (moduleScores.get(file.module_id) ?? 0) + structuralPrior + value * 10);
  }
  for (const surface of surfaces.data.surfaces) {
    const value = score(`${surface.id} ${surface.path} ${surface.kind}`, wanted);
    moduleScores.set(surface.module_id, (moduleScores.get(surface.module_id) ?? 0) + value * 2);
  }
  const ranked = [...moduleScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .filter(([, value], index) => value > 0 || index === 0)
    .map(([id]) => id);
  // Reserve room for immediate producers/consumers of the strongest matches.
  // This keeps the applicable test module and neighboring public contract in
  // the packet instead of letting plan/document filenames consume every slot.
  const primary = ranked.slice(0, 4);
  const related = graph.data.modules
    .filter((module) => primary.includes(module.id))
    .flatMap((module) => [...module.dependencies, ...module.consumers]);
  const selected = [...new Set([...primary, ...related, ...ranked])].slice(0, 6);

  const files = inventory.data.files.filter((f) => selected.includes(f.module_id)).slice(0, 30);
  const symbolRows = symbols.data.symbols
    .filter((s) => selected.includes(s.module_id ?? '') || score(`${s.name} ${s.evidence.path}`, wanted) > 0)
    .slice(0, 30);
  const surfaceRows = surfaces.data.surfaces.filter((s) => selected.includes(s.module_id)).slice(0, 20);
  const graphRows = graph.data.modules.filter((m) => selected.includes(m.id));
  const freshness = `${state.data.status} @ ${state.data.mapped_commit} (${state.data.mapped_at})`;
  const parts = [
    'CODEBASE MAP CONTEXT (deterministic local query; use cited existing paths/symbols, do not invent them)',
    `Freshness: ${freshness}`,
    summary.trim(),
    `Related modules:\n${graphRows
      .map((m) => `- ${m.id}: paths=${m.paths.join(', ')} dependencies=${m.dependencies.join(', ') || 'none'} consumers=${m.consumers.join(', ') || 'none'}`)
      .join('\n')}`,
    `Related files and contracts:\n${files.map((f) => `- ${f.path} [${f.kind}] exports=${f.exports.join(', ') || 'none'}`).join('\n')}`,
    `Related symbols:\n${symbolRows
      .map((s) => `- ${s.name} — ${s.evidence.path}${s.evidence.lines ? `:${s.evidence.lines}` : ''} sha256=${s.evidence.file_hash}`)
      .join('\n')}`,
    `Related surfaces:\n${surfaceRows.map((s) => `- ${s.kind} ${s.method ?? ''} ${s.path} — ${s.evidence.path}`).join('\n')}`,
  ].filter((p) => p.trim() !== '');
  let text = boundedJoin(parts, budgetBytes);
  if (Buffer.byteLength(text) > budgetBytes) text = text.slice(0, Math.max(0, budgetBytes - 20));
  return {
    text,
    bytes: Buffer.byteLength(text),
    files_loaded: loaded.filter((p) => fs.existsSync(p)),
    selected_modules: selected,
    freshness,
  };
}

/**
 * Reject fabricated references deterministically. Existing files named by a
 * task must be backed by a current inventory hash; symbols must also exist in
 * symbols.json at that path. Non-existing task files are treated as proposed
 * additions only when their parent directory is real.
 */
export function validatePlanMapReferences(projectRoot: string, plan: PhasePlan): PlanMapReferenceIssue[] {
  const paths = new RijoPaths(projectRoot);
  const inventory = InventoryDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'inventory.json')));
  const symbols = SymbolsDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'symbols.json')));
  const claims = ClaimsDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'claims.json')));
  if (!inventory.success || !symbols.success) return [];

  const byPath = new Map(inventory.data.files.map((entry) => [entry.path, entry]));
  const symbolKeys = new Set([
    ...symbols.data.symbols.map((entry) => `${entry.evidence.path}\0${entry.name}`),
    ...(claims.success
      ? claims.data.claims.flatMap((claim) =>
          claim.evidence
            .filter((evidence) => evidence.symbol)
            .map((evidence) => `${evidence.path}\0${evidence.symbol}`),
        )
      : []),
  ]);
  const issues: PlanMapReferenceIssue[] = [];
  for (const task of plan.tasks) {
    for (const reference of task.mapped_references) {
      const entry = byPath.get(reference.path);
      if (!entry) {
        issues.push({
          code: 'MAP_PATH_NOT_FOUND',
          task_id: task.id,
          message: `${reference.path} is not present in the current codebase inventory`,
        });
        continue;
      }
      if (entry.file_hash !== reference.file_hash) {
        issues.push({
          code: 'MAP_HASH_MISMATCH',
          task_id: task.id,
          message: `${reference.path} hash does not match the current map`,
        });
      }
      if (reference.symbol && !symbolKeys.has(`${reference.path}\0${reference.symbol}`)) {
        issues.push({
          code: 'MAP_SYMBOL_NOT_FOUND',
          task_id: task.id,
          message: `${reference.symbol} is not mapped at ${reference.path}`,
        });
      }
    }
    for (const file of task.files) {
      const normalized = file.replace(/^\.\//, '').replace(/\\/g, '/');
      const absolute = path.resolve(projectRoot, normalized);
      if (!absolute.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
        issues.push({
          code: 'MAP_PATH_NOT_FOUND',
          task_id: task.id,
          message: `${normalized} escapes the project and cannot be a mapped or new file`,
        });
      }
    }
  }
  return issues;
}
