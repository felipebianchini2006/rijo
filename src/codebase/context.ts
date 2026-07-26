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

export function gapsAffectingScope(gaps: string[], scopeText: string): string[] {
  const scopeTerms = terms(scopeText);
  const pathPattern =
    /(?:\.rijo\/[A-Za-z0-9_./-]+|(?:src|lib|app|apps|packages|tests?|migrations?|scripts?|config)\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|sql|json|ya?ml|toml|md))/gi;
  return gaps.filter((gap) => {
    if (/\b(?:critical|unsafe|contradiction|conflicting owners?|invented path|invented symbol)\b/i.test(gap)) {
      return true;
    }
    if (/^Coverage gap in /i.test(gap) || /Brownfield baseline status is (?:FAILED|BLOCKED)/i.test(gap)) {
      return true;
    }
    const paths = [...gap.matchAll(pathPattern)].map((match) => match[0]!.replace(/[.,;:]+$/, ''));
    if (paths.length === 0) return true;
    return paths.some((candidate) => {
      if (candidate.startsWith('.rijo/')) return false;
      const normalized = candidate.toLowerCase();
      const basename = path.posix.basename(normalized, path.posix.extname(normalized));
      const moduleParts = normalized.split('/').filter((part) => part.length >= 3);
      return (
        scopeText.toLowerCase().includes(normalized) ||
        (basename.length >= 3 && scopeTerms.has(basename)) ||
        moduleParts.some((part) => scopeTerms.has(part))
      );
    });
  });
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

function clip(text: string, maxChars = 1_200): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars)}…`;
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
  const conventions = loadText('CONVENTIONS.md');
  const baselineText = loadText('BASELINE.md');
  const concerns = loadText('CONCERNS.md');
  const inventoryRaw = loadJson<unknown>('inventory.json');
  const symbolsRaw = loadJson<unknown>('symbols.json');
  const surfacesRaw = loadJson<unknown>('surfaces.json');
  const graphRaw = loadJson<unknown>('dependency-graph.json');
  const claimsRaw = loadJson<unknown>('claims.json');
  const stateRaw = loadJson<unknown>('map-state.json');
  loaded.push(paths.decisions);
  const decisions = readTextIfExists(paths.decisions) ?? '';
  const inventory = InventoryDocumentSchema.safeParse(inventoryRaw);
  const symbols = SymbolsDocumentSchema.safeParse(symbolsRaw);
  const surfaces = SurfacesDocumentSchema.safeParse(surfacesRaw);
  const graph = DependencyGraphSchema.safeParse(graphRaw);
  const claims = ClaimsDocumentSchema.safeParse(claimsRaw);
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
  const selectedPaths = new Set(files.map((file) => file.path));
  const selectedClaims = claims.success
    ? claims.data.claims.filter(
        (claim) =>
          claim.evidence.some((item) => selectedPaths.has(item.path)) ||
          score(`${claim.kind} ${claim.statement}`, wanted) > 0,
      )
    : [];
  const contractRows = selectedClaims.filter((claim) => claim.kind === 'contract');
  const riskRows = selectedClaims.filter((claim) => claim.kind === 'risk');
  const testRows = files.filter((file) => file.kind === 'test');
  const freshness = `${state.data.status} @ ${state.data.mapped_commit} (${state.data.mapped_at})`;
  const parts = [
    'CODEBASE MAP CONTEXT (deterministic local query; use cited existing paths/symbols, do not invent them)',
    `Freshness: ${freshness}`,
    summary.trim(),
    `Related files and contracts:\n${files
      .map(
        (f) =>
          `- ${f.path} [${f.kind}] sha256=${f.file_hash} exports=${f.exports.join(', ') || 'none'}`,
      )
      .join('\n')}`,
    `Related symbols:\n${symbolRows
      .map((s) => `- ${s.name} — ${s.evidence.path}${s.evidence.lines ? `:${s.evidence.lines}` : ''} sha256=${s.evidence.file_hash}`)
      .join('\n')}`,
    `Conventions:\n${clip(conventions) || '- No mapped convention for the selected scope.'}`,
    `Brownfield Baseline:\n${clip(baselineText) || `- ${state.data.baseline_status}`}`,
    `Risks:\n${
      riskRows.length
        ? riskRows.map((claim) => `- ${claim.statement} (${claim.evidence.map((item) => item.path).join(', ')})`).join('\n')
        : clip(concerns) || '- No mapped risk for the selected scope.'
    }`,
    `Previous decisions:\n${clip(decisions) || '- No previous material decision recorded.'}`,
    `Mapped contracts:\n${
      contractRows.length
        ? contractRows.map((claim) => `- ${claim.statement} (${claim.evidence.map((item) => item.path).join(', ')})`).join('\n')
        : '- No additional claim-level contract for the selected scope.'
    }`,
    `Freshness gaps:\n${state.data.gaps.length ? state.data.gaps.map((gap) => `- ${gap}`).join('\n') : '- none'}`,
    `Related tests:\n${testRows.length ? testRows.map((file) => `- ${file.path}`).join('\n') : '- none detected'}`,
    `Related modules:\n${graphRows
      .map((m) => `- ${m.id}: paths=${m.paths.join(', ')} dependencies=${m.dependencies.join(', ') || 'none'} consumers=${m.consumers.join(', ') || 'none'}`)
      .join('\n')}`,
    `Related surfaces:\n${surfaceRows.map((s) => `- ${s.kind} ${s.method ?? ''} ${s.path} — ${s.evidence.path}`).join('\n')}`,
  ].filter((p) => p.trim() !== '');
  let text = boundedJoin(parts, budgetBytes);
  while (Buffer.byteLength(text) > budgetBytes && text.length > 0) text = text.slice(0, -1);
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
