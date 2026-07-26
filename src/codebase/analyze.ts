import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '../core/fsx.js';
import {
  DependencyGraphSchema,
  EvidenceSchema,
  MapAgentFragmentSchema,
  MapClaimSchema,
  SurfaceRecordSchema,
  SurfacesDocumentSchema,
  SymbolRecordSchema,
  SymbolsDocumentSchema,
  type CodebaseInventoryEntry,
  type CodebaseCoverage,
  type DependencyGraph,
  type Evidence,
  type InventoryDocument,
  type MapAgentFragment,
  type MapClaim,
  type SurfacesDocument,
  type SymbolsDocument,
} from './schemas.js';

function content(root: string, entry: CodebaseInventoryEntry): string {
  return fs.readFileSync(path.join(root, entry.path), 'utf8');
}

function evidence(entry: CodebaseInventoryEntry, line?: number, symbol?: string): Evidence {
  return EvidenceSchema.parse({
    path: entry.path,
    ...(line ? { lines: String(line) } : {}),
    ...(symbol ? { symbol } : {}),
    file_hash: entry.file_hash,
  });
}

export function extractSymbols(root: string, inventory: InventoryDocument): SymbolsDocument {
  const symbols: Array<ReturnType<typeof SymbolRecordSchema.parse>> = [];
  for (const file of inventory.files.filter((f) => f.kind === 'code' || f.kind === 'configuration')) {
    if (file.exports.length === 0) continue;
    const lines = content(root, file).split(/\r?\n/);
    for (const name of file.exports) {
      const index = lines.findIndex((line) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line));
      const line = index >= 0 ? index + 1 : 1;
      const sourceLine = lines[index] ?? '';
      const kind = /\bclass\b/.test(sourceLine)
        ? 'class'
        : /\binterface\b/.test(sourceLine)
          ? 'interface'
          : /\btype\b/.test(sourceLine)
            ? 'type'
            : /\b(function|=>)\b/.test(sourceLine)
              ? 'function'
              : 'constant';
      symbols.push(SymbolRecordSchema.parse({ name, kind, evidence: evidence(file, line, name), module_id: file.module_id }));
    }
  }
  return SymbolsDocumentSchema.parse({ symbols });
}

function addSurface(
  out: SurfacesDocument['surfaces'],
  entry: CodebaseInventoryEntry,
  fields: Omit<SurfacesDocument['surfaces'][number], 'evidence' | 'module_id'>,
  line: number,
): void {
  out.push(SurfaceRecordSchema.parse({ ...fields, evidence: evidence(entry, line), module_id: entry.module_id }));
}

export function extractSurfaces(root: string, inventory: InventoryDocument): SurfacesDocument {
  const surfaces: SurfacesDocument['surfaces'] = [];
  for (const file of inventory.files.filter((f) => f.kind === 'code')) {
    const source = content(root, file);
    const lineAt = (offset: number) => source.slice(0, offset).split(/\r?\n/).length;
    for (const match of source.matchAll(/\b(?:app|router|server)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)['"`]/gi)) {
      addSurface(
        surfaces,
        file,
        { id: `${match[1]!.toUpperCase()} ${match[2]}`, kind: 'http', method: match[1]!.toUpperCase(), path: match[2]! },
        lineAt(match.index),
      );
    }
    for (const match of source.matchAll(/\bcase\s+['"]([^'"]+)['"]\s*:/g)) {
      if (!/cli|command|main/i.test(file.path)) continue;
      addSurface(surfaces, file, { id: `cli:${match[1]}`, kind: 'cli', method: null, path: match[1]! }, lineAt(match.index));
    }
    for (const match of source.matchAll(/['"]workflow\.([a-z][a-z0-9_.-]+)['"]/gi)) {
      addSurface(
        surfaces,
        file,
        { id: `rpc:workflow.${match[1]}`, kind: 'rpc', method: 'JSON-RPC', path: `workflow.${match[1]}` },
        lineAt(match.index),
      );
    }
    if (/(^|\/)(app|pages)\/.+\/page\.(tsx?|jsx?)$/.test(file.path)) {
      const route = file.path
        .replace(/^.*?(?:app|pages)\//, '/')
        .replace(/\/page\.(tsx?|jsx?)$/, '')
        .replace(/\([^/]+\)\//g, '')
        .replace(/\[([^\]]+)\]/g, ':$1');
      addSurface(surfaces, file, { id: `ui:${route}`, kind: 'ui_route', method: null, path: route || '/' }, 1);
    }
    for (const match of source.matchAll(/\b(?:emit|publish|dispatch)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      addSurface(surfaces, file, { id: `event:${match[1]}`, kind: 'event', method: null, path: match[1]! }, lineAt(match.index));
    }
    if (/webhook/i.test(file.path)) addSurface(surfaces, file, { id: `webhook:${file.path}`, kind: 'webhook', method: null, path: file.path }, 1);
    if (/(^|\/)(jobs?|workers?|cron)(\/|\.|$)/i.test(file.path)) {
      addSurface(surfaces, file, { id: `job:${file.path}`, kind: 'job', method: null, path: file.path }, 1);
    }
  }
  const unique = new Map(surfaces.map((surface) => [`${surface.kind}:${surface.path}:${surface.evidence.path}`, surface]));
  return SurfacesDocumentSchema.parse({ surfaces: [...unique.values()] });
}

function resolveImport(from: string, imported: string, inventoryPaths: Set<string>): string | null {
  if (!imported.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), imported));
  const sourceBase = /\.[cm]?jsx?$/.test(base) ? base.replace(/\.[cm]?jsx?$/, '') : base;
  const candidates = [
    base,
    `${sourceBase}.ts`,
    `${sourceBase}.tsx`,
    `${sourceBase}.mts`,
    `${sourceBase}.cts`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  return candidates.find((candidate) => inventoryPaths.has(candidate)) ?? null;
}

export function buildDependencyGraph(inventory: InventoryDocument): DependencyGraph {
  const paths = new Set(inventory.files.map((f) => f.path));
  const modules = new Map<string, { paths: string[]; dependencies: Set<string>; consumers: Set<string> }>();
  for (const file of inventory.files) {
    const current = modules.get(file.module_id) ?? { paths: [], dependencies: new Set<string>(), consumers: new Set<string>() };
    current.paths.push(file.path);
    modules.set(file.module_id, current);
  }
  for (const file of inventory.files) {
    for (const imported of file.imports) {
      const targetPath = resolveImport(file.path, imported, paths);
      if (!targetPath) continue;
      const target = inventory.files.find((candidate) => candidate.path === targetPath);
      if (!target || target.module_id === file.module_id) continue;
      modules.get(file.module_id)!.dependencies.add(target.module_id);
      modules.get(target.module_id)!.consumers.add(file.module_id);
    }
  }
  return DependencyGraphSchema.parse({
    modules: [...modules.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, value]) => ({
        id,
        paths: value.paths.sort(),
        dependencies: [...value.dependencies].sort(),
        consumers: [...value.consumers].sort(),
      })),
  });
}

export interface MapShard {
  id: string;
  module_ids: string[];
  files: CodebaseInventoryEntry[];
}

function moduleSegments(
  moduleId: string,
  files: CodebaseInventoryEntry[],
  maxFiles: number,
  maxBytes: number,
): Array<{ moduleId: string; files: CodebaseInventoryEntry[] }> {
  const segments: Array<{ moduleId: string; files: CodebaseInventoryEntry[] }> = [];
  let current: CodebaseInventoryEntry[] = [];
  let bytes = 0;
  for (const file of [...files].sort((a, b) => {
    const dirOrder = path.posix.dirname(a.path).localeCompare(path.posix.dirname(b.path));
    return dirOrder || a.path.localeCompare(b.path);
  })) {
    if (current.length > 0 && (current.length + 1 > maxFiles || bytes + file.bytes > maxBytes)) {
      segments.push({ moduleId, files: current });
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.bytes;
  }
  if (current.length > 0) segments.push({ moduleId, files: current });
  return segments;
}

export function partitionInventory(
  inventory: InventoryDocument,
  scopedPaths: string[] = [],
  maxFiles = 45,
  maxBytes = 180_000,
): MapShard[] {
  const affected = scopedPaths.length
    ? inventory.files.filter((f) => scopedPaths.some((scope) => f.path === scope || f.path.startsWith(`${scope.replace(/\/$/, '')}/`)))
    : inventory.files;
  const byModule = new Map<string, CodebaseInventoryEntry[]>();
  for (const file of affected) {
    const list = byModule.get(file.module_id) ?? [];
    list.push(file);
    byModule.set(file.module_id, list);
  }
  const shards: MapShard[] = [];
  let current: MapShard = { id: 'map-shard-1', module_ids: [], files: [] };
  let bytes = 0;
  for (const [moduleId, files] of [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const segment of moduleSegments(moduleId, files, maxFiles, maxBytes)) {
      const segmentBytes = segment.files.reduce((sum, file) => sum + file.bytes, 0);
      if (
        current.files.length > 0 &&
        (current.files.length + segment.files.length > maxFiles || bytes + segmentBytes > maxBytes)
      ) {
        shards.push(current);
        current = { id: `map-shard-${shards.length + 1}`, module_ids: [], files: [] };
        bytes = 0;
      }
      if (!current.module_ids.includes(segment.moduleId)) current.module_ids.push(segment.moduleId);
      current.files.push(...segment.files);
      bytes += segmentBytes;
    }
  }
  if (current.files.length > 0) shards.push(current);
  return shards;
}

export function expandImpactPaths(
  inventory: InventoryDocument,
  graph: DependencyGraph,
  surfaces: SurfacesDocument,
  changedPaths: string[],
): string[] {
  const normalized = changedPaths.map((item) => item.replace(/\\/g, '/').replace(/\/+$/, ''));
  const directlyChanged = inventory.files.filter((file) =>
    normalized.some((scope) => file.path === scope || file.path.startsWith(`${scope}/`)),
  );
  const impactedModules = new Set(directlyChanged.map((file) => file.module_id));
  for (const moduleId of [...impactedModules]) {
    const module = graph.modules.find((candidate) => candidate.id === moduleId);
    if (!module) continue;
    for (const neighbor of [...module.dependencies, ...module.consumers]) impactedModules.add(neighbor);
  }
  for (const surface of surfaces.surfaces) {
    if (directlyChanged.some((file) => file.path === surface.evidence.path)) impactedModules.add(surface.module_id);
  }
  const ownerTerms = new Set(
    directlyChanged.flatMap((file) => [
      file.module_id.split('/').at(-1)!.toLowerCase(),
      path.posix.basename(file.path, path.posix.extname(file.path)).toLowerCase(),
    ]),
  );
  const impacted = inventory.files.filter((file) => {
    if (impactedModules.has(file.module_id)) return true;
    if (!['test', 'migration', 'script', 'configuration'].includes(file.kind)) return false;
    const searchable = `${file.path} ${file.imports.join(' ')}`.toLowerCase();
    return [...ownerTerms].some((term) => term.length >= 3 && searchable.includes(term));
  });
  return [...new Set([...normalized, ...impacted.map((file) => file.path)])].sort();
}

export interface MapCoverageAssessment {
  coverage: CodebaseCoverage;
  status: 'COMPLETE' | 'PARTIAL' | 'BLOCKED';
  gaps: string[];
}

export function assessMapCoverage(
  inventory: InventoryDocument,
  symbols: SymbolsDocument,
  surfaces: SurfacesDocument,
  graph: DependencyGraph,
  claims: MapClaim[],
  options: { baselineStatus: string; gaps: string[] },
): MapCoverageAssessment {
  const analyzedEvidence = new Set([
    ...claims.flatMap((claim) => claim.evidence.map((item) => item.path)),
    ...symbols.symbols.map((symbol) => symbol.evidence.path),
    ...surfaces.surfaces.map((surface) => surface.evidence.path),
  ]);
  const ratio = (covered: number, total: number, emptyValue = 1): number =>
    total === 0 ? emptyValue : Math.min(1, covered / total);
  const relevantExclusions = inventory.excluded_paths.filter((item) =>
    ['large_file', 'unreadable'].includes(item.reason),
  );
  const entrypoints = inventory.files.filter((file) => /(^|\/)(index|main|app|server|cli)\.[^.]+$/.test(file.path));
  const modulesCovered = new Set(
    claims.flatMap((claim) =>
      claim.evidence
        .map((item) => inventory.files.find((file) => file.path === item.path)?.module_id)
        .filter((moduleId): moduleId is string => Boolean(moduleId)),
    ),
  );
  const exportedSymbols = inventory.files.flatMap((file) =>
    file.exports.map((name) => `${file.path}\0${name}`),
  );
  const coveredSymbols = new Set(
    symbols.symbols.map((symbol) => `${symbol.evidence.path}\0${symbol.name.split('.').at(-1)}`),
  );
  const dataFiles = inventory.files.filter(
    (file) => file.kind === 'migration' || /(^|\/)(models?|schemas?|db)(\/|$)/i.test(file.path),
  );
  const testsOperations = inventory.files.filter(
    (file) => file.kind === 'test' || file.kind === 'script' || /Dockerfile|\.github\//i.test(file.path),
  );
  const baselinePassed = options.baselineStatus === 'PASSED';
  const coverage = {
    relevant_files_classified: ratio(inventory.files.length, inventory.files.length + relevantExclusions.length),
    entrypoints_covered: ratio(entrypoints.filter((file) => analyzedEvidence.has(file.path)).length, entrypoints.length),
    modules_covered: ratio(modulesCovered.size, graph.modules.length, 0),
    public_contracts_covered: ratio(
      exportedSymbols.filter((key) => coveredSymbols.has(key)).length,
      exportedSymbols.length,
    ),
    surfaces_covered: ratio(
      surfaces.surfaces.filter((surface) => analyzedEvidence.has(surface.evidence.path)).length,
      surfaces.surfaces.length,
    ),
    data_covered: ratio(dataFiles.filter((file) => analyzedEvidence.has(file.path)).length, dataFiles.length),
    tests_operations_covered: ratio(
      testsOperations.filter((file) => baselinePassed || analyzedEvidence.has(file.path)).length,
      testsOperations.length,
    ),
    claims_verified: ratio(claims.length, claims.length, 0),
  } satisfies CodebaseCoverage;
  const derivedGaps = [...options.gaps];
  if (relevantExclusions.length > 0) {
    derivedGaps.push(
      `${relevantExclusions.length} relevant file(s) were not analyzed: ${relevantExclusions
        .slice(0, 20)
        .map((item) => item.path)
        .join(', ')}`,
    );
  }
  for (const [area, value] of Object.entries(coverage)) {
    if (value < 1) derivedGaps.push(`Coverage gap in ${area}: ${(value * 100).toFixed(1)}%`);
  }
  if (['FAILED', 'BLOCKED_BY_SANDBOX', 'DETECTED_NOT_RUN'].includes(options.baselineStatus)) {
    derivedGaps.push(`Brownfield baseline status is ${options.baselineStatus}.`);
  }
  const uniqueGaps = [...new Set(derivedGaps)];
  const criticalGap = uniqueGaps.some((gap) =>
    /\b(?:critical|unsafe|contradiction|conflicting owners?|ownership conflict|invented path|invented symbol)\b/i.test(gap),
  );
  const mandatoryPass = Object.values(coverage).every((value) => value === 1);
  const status =
    criticalGap || inventory.files.length === 0 || graph.modules.length === 0
      ? 'BLOCKED'
      : uniqueGaps.length === 0 && mandatoryPass
        ? 'COMPLETE'
        : 'PARTIAL';
  return { coverage, status, gaps: uniqueGaps };
}

export function deterministicClaims(inventory: InventoryDocument, graph: DependencyGraph): MapClaim[] {
  const byModule = new Map<string, CodebaseInventoryEntry[]>();
  for (const file of inventory.files) {
    const list = byModule.get(file.module_id) ?? [];
    list.push(file);
    byModule.set(file.module_id, list);
  }
  const claims: MapClaim[] = [];
  for (const module of graph.modules) {
    const files = byModule.get(module.id) ?? [];
    const anchor = files.find((f) => f.kind === 'code') ?? files[0];
    if (!anchor) continue;
    const exported = files.flatMap((f) => f.exports);
    claims.push(
      MapClaimSchema.parse({
        kind: 'responsibility',
        statement: `Module ${module.id} owns ${files.length} mapped file(s) under ${module.paths.slice(0, 4).join(', ')}.`,
        evidence: [evidence(anchor)],
      }),
    );
    if (exported.length > 0) {
      claims.push(
        MapClaimSchema.parse({
          kind: 'contract',
          statement: `Module ${module.id} exposes ${[...new Set(exported)].slice(0, 20).join(', ')}.`,
          evidence: files.filter((f) => f.exports.length > 0).slice(0, 5).map((f) => evidence(f)),
        }),
      );
    }
  }
  return claims;
}

export function validateFragment(
  projectRoot: string,
  inventory: InventoryDocument,
  raw: unknown,
  allowedModules: string[],
): MapAgentFragment | null {
  return validateFragmentDetailed(projectRoot, inventory, raw, allowedModules).fragment;
}

function evidenceSymbolExists(fileText: string, symbol: string): boolean {
  const leaf = symbol.split('.').at(-1)!;
  if (fileText.includes(leaf)) return true;
  const testAnchor = /^(test|it|describe)\((['"])(.*)\2\)$/.exec(symbol);
  if (!testAnchor) return false;
  const [, call, , label] = testAnchor;
  return fileText.includes(`${call}('${label}'`) || fileText.includes(`${call}("${label}"`);
}

export function validateFragmentDetailed(
  projectRoot: string,
  inventory: InventoryDocument,
  raw: unknown,
  allowedModules: string[],
): { fragment: MapAgentFragment | null; errors: string[] } {
  const parsed = MapAgentFragmentSchema.safeParse(expandCombinedEvidenceSymbols(raw));
  if (!parsed.success) {
    return {
      fragment: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const wrongModules = parsed.data.module_ids.filter((id) => !allowedModules.includes(id));
  if (wrongModules.length > 0) {
    return { fragment: null, errors: [`modules outside assigned shard: ${wrongModules.join(', ')}`] };
  }
  const byPath = new Map(inventory.files.map((f) => [f.path, f]));
  for (const claim of parsed.data.claims) {
    for (const ev of claim.evidence) {
      const entry = byPath.get(ev.path);
      if (!entry) return { fragment: null, errors: [`unmapped evidence path: ${ev.path}`] };
      if (!allowedModules.includes(entry.module_id)) {
        return {
          fragment: null,
          errors: [`evidence path ${ev.path} is owned by ${entry.module_id}, outside assigned shard modules`],
        };
      }
      if (entry.file_hash !== ev.file_hash) {
        return { fragment: null, errors: [`hash mismatch for ${ev.path}`] };
      }
      const absolute = path.join(projectRoot, ev.path);
      if (!fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== ev.file_hash) {
        return { fragment: null, errors: [`live file mismatch for ${ev.path}`] };
      }
      if (ev.lines) {
        const [start, end = start] = ev.lines.split('-').map(Number);
        const count = fs.readFileSync(absolute, 'utf8').split(/\r?\n/).length;
        if (!start || !end || start > end || end > count) {
          return { fragment: null, errors: [`invalid line range ${ev.lines} for ${ev.path} (${count} lines)`] };
        }
      }
      if (ev.symbol) {
        const fileText = fs.readFileSync(absolute, 'utf8');
        if (!evidenceSymbolExists(fileText, ev.symbol)) {
          return { fragment: null, errors: [`symbol ${ev.symbol} not found in ${ev.path}`] };
        }
      }
    }
  }
  return { fragment: parsed.data, errors: [] };
}

/**
 * Hosts occasionally serialize several symbols from one file into a single
 * comma-separated evidence field. A comma cannot occur in a JavaScript,
 * Python, or Go symbol identifier, so split that representation into exact
 * evidence entries before validation. Every resulting symbol still passes the
 * live-file check below; this never weakens the evidence gate.
 */
function expandCombinedEvidenceSymbols(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const fragment = raw as Record<string, unknown>;
  if (!Array.isArray(fragment.claims)) return raw;
  return {
    ...fragment,
    claims: fragment.claims.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
      const claim = candidate as Record<string, unknown>;
      if (!Array.isArray(claim.evidence)) return candidate;
      return {
        ...claim,
        evidence: claim.evidence.flatMap((candidateEvidence) => {
          if (!candidateEvidence || typeof candidateEvidence !== 'object' || Array.isArray(candidateEvidence)) {
            return [candidateEvidence];
          }
          const evidence = candidateEvidence as Record<string, unknown>;
          if (typeof evidence.symbol !== 'string' || !evidence.symbol.includes(',')) return [candidateEvidence];
          const symbols = evidence.symbol.split(',').map((symbol) => symbol.trim()).filter(Boolean);
          return symbols.length > 1 ? symbols.map((symbol) => ({ ...evidence, symbol })) : [candidateEvidence];
        }),
      };
    }),
  };
}

export function validateClaims(projectRoot: string, inventory: InventoryDocument, claims: MapClaim[]): string[] {
  const errors: string[] = [];
  const byPath = new Map(inventory.files.map((f) => [f.path, f]));
  for (const [index, claim] of claims.entries()) {
    for (const ev of claim.evidence) {
      const entry = byPath.get(ev.path);
      if (!entry) errors.push(`claim ${index}: missing path ${ev.path}`);
      else if (entry.file_hash !== ev.file_hash) errors.push(`claim ${index}: hash mismatch ${ev.path}`);
      else if (!fs.existsSync(path.join(projectRoot, ev.path))) errors.push(`claim ${index}: path vanished ${ev.path}`);
    }
  }
  return errors;
}
