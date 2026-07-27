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
  type ClaimReceipt,
  type DependencyGraph,
  type Evidence,
  type InventoryDocument,
  type MapAgentFragment,
  type MapClaim,
  type MapGap,
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
  gapRecords: MapGap[];
}

export function assessMapCoverage(
  inventory: InventoryDocument,
  symbols: SymbolsDocument,
  surfaces: SurfacesDocument,
  graph: DependencyGraph,
  claims: MapClaim[],
  options: {
    baselineStatus: string;
    gaps: string[];
    gapRecords?: MapGap[];
    claimReceipts?: ClaimReceipt[];
    runtimeAvailable?: boolean;
    baselineWaiverSafe?: boolean;
  },
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
  const behavioralModuleIds = new Set(
    inventory.files
      .filter((file) => ['code', 'test', 'configuration', 'migration', 'script'].includes(file.kind))
      .map((file) => file.module_id),
  );
  const uncoveredBehavioralModules = [...behavioralModuleIds].filter(
    (moduleId) => !modulesCovered.has(moduleId),
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
  const baselinePassed =
    options.baselineStatus === 'PASSED' ||
    (options.baselineStatus === 'WAIVED' && options.baselineWaiverSafe === true);
  const receiptsByClaim = new Map((options.claimReceipts ?? []).map((receipt) => [receipt.claim_id, receipt]));
  const candidateClaimIds = new Set([
    ...claims.map((claim, index) => claim.claim_id ?? `unidentified-${index}`),
    ...(options.claimReceipts ?? []).map((receipt) => receipt.claim_id),
  ]);
  const approvedClaims = [...candidateClaimIds].filter((claimId) => {
    const receipt = receiptsByClaim.get(claimId);
    return (
      receipt?.structural_status === 'PASSED' &&
      receipt.semantic_status === 'APPROVED' &&
      receipt.final_disposition === 'APPROVED'
    );
  }).length;
  const coverage = {
    relevant_files_classified: ratio(inventory.files.length, inventory.files.length + relevantExclusions.length),
    entrypoints_covered: ratio(entrypoints.filter((file) => analyzedEvidence.has(file.path)).length, entrypoints.length),
    modules_covered: ratio(
      [...behavioralModuleIds].filter((moduleId) => modulesCovered.has(moduleId)).length,
      behavioralModuleIds.size,
      1,
    ),
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
    claims_verified: ratio(approvedClaims, candidateClaimIds.size, 0),
  } satisfies CodebaseCoverage;
  const derivedGaps = [...options.gaps];
  const gapRecords: MapGap[] = [...(options.gapRecords ?? [])];
  if (relevantExclusions.length > 0) {
    const message = `${relevantExclusions.length} relevant file(s) were not analyzed: ${relevantExclusions
      .slice(0, 20)
      .map((item) => item.path)
      .join(', ')}`;
    derivedGaps.push(message);
    gapRecords.push({
      code: 'RELEVANT_FILE_UNANALYZED',
      category: 'coverage',
      severity: 'critical',
      message,
      affected_paths: relevantExclusions.map((item) => item.path),
      affected_modules: [],
    });
  }
  for (const [area, value] of Object.entries(coverage)) {
    if (value < 1) {
      const message = `Coverage gap in ${area}: ${(value * 100).toFixed(1)}%`;
      const affectedPaths =
        area === 'relevant_files_classified'
          ? relevantExclusions.map((item) => item.path)
          : area === 'entrypoints_covered'
            ? entrypoints.filter((file) => !analyzedEvidence.has(file.path)).map((file) => file.path)
            : area === 'public_contracts_covered'
              ? inventory.files
                  .filter((file) =>
                    file.exports.some((name) => !coveredSymbols.has(`${file.path}\0${name}`)),
                  )
                  .map((file) => file.path)
              : area === 'surfaces_covered'
                ? surfaces.surfaces
                    .filter((surface) => !analyzedEvidence.has(surface.evidence.path))
                    .map((surface) => surface.evidence.path)
                : area === 'data_covered'
                  ? dataFiles.filter((file) => !analyzedEvidence.has(file.path)).map((file) => file.path)
                  : area === 'tests_operations_covered'
                    ? testsOperations
                        .filter((file) => !baselinePassed && !analyzedEvidence.has(file.path))
                        .map((file) => file.path)
                    : [];
      const affectedModules =
        area === 'modules_covered'
          ? uncoveredBehavioralModules
          : [
              ...new Set(
                affectedPaths
                  .map((affected) => inventory.files.find((file) => file.path === affected)?.module_id)
                  .filter((moduleId): moduleId is string => Boolean(moduleId)),
              ),
            ];
      derivedGaps.push(message);
      gapRecords.push({
        code: area === 'claims_verified' ? 'REVIEW_INCOMPLETE' : 'COVERAGE_INCOMPLETE',
        category: area === 'claims_verified' ? 'semantic' : 'coverage',
        severity: area === 'claims_verified' ? 'critical' : 'non_critical',
        message,
        affected_paths: affectedPaths,
        affected_modules: affectedModules,
      });
    }
  }
  if (
    ['FAILED', 'BLOCKED_BY_SANDBOX', 'DETECTED_NOT_RUN'].includes(options.baselineStatus) ||
    (options.baselineStatus === 'WAIVED' && options.baselineWaiverSafe !== true)
  ) {
    const message = `Brownfield baseline status is ${options.baselineStatus}.`;
    derivedGaps.push(message);
    gapRecords.push({
      code: 'BASELINE_UNSAFE',
      category: 'baseline',
      severity: 'critical',
      message,
      affected_paths: [],
      affected_modules: [],
    });
  }
  const behavioralFiles = inventory.files.filter((file) =>
    ['code', 'test', 'configuration', 'migration', 'script'].includes(file.kind),
  );
  if (behavioralFiles.length > 0 && options.runtimeAvailable === false) {
    const message = 'No agent runtime was bound for required semantic analysis.';
    derivedGaps.push(message);
    gapRecords.push({
      code: 'RUNTIME_REQUIRED',
      category: 'runtime',
      severity: 'critical',
      message,
      affected_paths: behavioralFiles.map((file) => file.path),
      affected_modules: [...new Set(behavioralFiles.map((file) => file.module_id))],
    });
  }
  const uniqueGaps = [...new Set(derivedGaps)];
  const uniqueGapRecords = [
    ...new Map(gapRecords.map((gap) => [`${gap.code}\0${gap.message}`, gap])).values(),
  ];
  const criticalGap = uniqueGapRecords.some((gap) => gap.severity === 'critical');
  const mandatoryPass = Object.values(coverage).every((value) => value === 1);
  const status =
    criticalGap || inventory.files.length === 0 || graph.modules.length === 0
      ? 'BLOCKED'
      : uniqueGaps.length === 0 && mandatoryPass
        ? 'COMPLETE'
        : 'PARTIAL';
  return { coverage, status, gaps: uniqueGaps, gapRecords: uniqueGapRecords };
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
  allowedPaths: Set<string>,
  neighborContractPaths: Set<string> = new Set(),
): MapAgentFragment | null {
  return validateFragmentDetailed(projectRoot, inventory, raw, allowedPaths, neighborContractPaths).fragment;
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
  allowedPaths: Set<string>,
  neighborContractPaths: Set<string> = new Set(),
): {
  fragment: MapAgentFragment | null;
  errors: string[];
  receipt: {
    shard_id: string;
    allowed_paths: string[];
    neighbor_contract_paths: string[];
    accepted_evidence: Array<{ path: string; ownership: 'primary' | 'external_contract' }>;
    rejected_evidence: Array<{ path: string; reason: string }>;
    semantic_coverage: MapAgentFragment['semantic_coverage'];
  };
} {
  const receipt = {
    shard_id:
      raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>)['shard_id'] === 'string'
        ? String((raw as Record<string, unknown>)['shard_id'])
        : 'invalid',
    allowed_paths: [...allowedPaths].sort(),
    neighbor_contract_paths: [...neighborContractPaths].sort(),
    accepted_evidence: [] as Array<{ path: string; ownership: 'primary' | 'external_contract' }>,
    rejected_evidence: [] as Array<{ path: string; reason: string }>,
    semantic_coverage: [] as MapAgentFragment['semantic_coverage'],
  };
  const parsed = MapAgentFragmentSchema.safeParse(expandCombinedEvidenceSymbols(raw));
  if (!parsed.success) {
    return {
      fragment: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      receipt,
    };
  }
  receipt.shard_id = parsed.data.shard_id;
  receipt.semantic_coverage = parsed.data.semantic_coverage;
  const allowedModules = new Set(
    inventory.files.filter((entry) => allowedPaths.has(entry.path)).map((entry) => entry.module_id),
  );
  const wrongModules = parsed.data.module_ids.filter((id) => !allowedModules.has(id));
  if (wrongModules.length > 0) {
    return { fragment: null, errors: [`modules outside assigned shard: ${wrongModules.join(', ')}`], receipt };
  }
  const byPath = new Map(inventory.files.map((f) => [f.path, f]));
  for (const claim of parsed.data.claims) {
    const evidenced = new Set(claim.evidence.map((item) => item.path));
    for (const entry of inventory.files) {
      if (
        claim.statement.includes(entry.path) &&
        !evidenced.has(entry.path) &&
        (allowedPaths.has(entry.path) || neighborContractPaths.has(entry.path))
      ) {
        claim.evidence.push({
          path: entry.path,
          file_hash: entry.file_hash,
          ownership: neighborContractPaths.has(entry.path) ? 'external_contract' : 'primary',
        });
        evidenced.add(entry.path);
      }
    }
  }
  const behavioralPaths = [...allowedPaths].filter((allowedPath) => {
    const entry = byPath.get(allowedPath);
    return entry && ['code', 'test', 'configuration', 'migration', 'script'].includes(entry.kind);
  });
  const genericClaims = parsed.data.claims.filter((claim) =>
    /^Module\s+\S+\s+(?:owns|has|contains)\s+\d+\s+(?:mapped\s+)?file/i.test(claim.statement),
  );
  if (
    behavioralPaths.length > 0 &&
    parsed.data.gaps.length === 0 &&
    (parsed.data.claims.length === 0 || genericClaims.length === parsed.data.claims.length)
  ) {
    return {
      fragment: null,
      errors: [
        `semantic analysis is insufficient for behavioral shard ${parsed.data.shard_id}: provide at least one non-generic semantic claim or a factual gap`,
      ],
      receipt,
    };
  }
  const errors: string[] = [];
  for (const [index, claim] of parsed.data.claims.entries()) {
    const outsideMentions = inventory.files
      .filter(
        (file) =>
          claim.statement.includes(file.path) &&
          !allowedPaths.has(file.path) &&
          !neighborContractPaths.has(file.path),
      )
      .map((file) => file.path);
    if (outsideMentions.length > 0) {
      errors.push(
        `claim ${index}: statement cites path(s) outside exact shard ownership: ${outsideMentions.join(', ')}; delete or rewrite this claim without those paths`,
      );
    }
  }
  errors.push(...validateClaims(projectRoot, inventory, parsed.data.claims));
  if (behavioralPaths.length > 0) {
    const categories = [
      'responsibility',
      'entrypoints',
      'contracts',
      'invariants',
      'dependencies',
      'consumers',
      'data_flow',
      'conventions',
      'tests',
      'operations',
      'risks',
      'placement',
    ] as const;
    const claimKinds: Record<(typeof categories)[number], MapClaim['kind'][]> = {
      responsibility: ['responsibility'],
      entrypoints: ['entrypoint', 'contract'],
      contracts: ['contract'],
      invariants: ['invariant'],
      dependencies: ['dependency', 'data_flow', 'contract', 'responsibility'],
      consumers: ['consumer', 'data_flow', 'contract', 'responsibility'],
      data_flow: ['data_flow'],
      conventions: ['convention'],
      tests: ['test', 'operation', 'invariant'],
      operations: ['operation'],
      risks: ['risk'],
      placement: ['placement', 'convention'],
    };
    const gapCodes: Record<(typeof categories)[number], MapAgentFragment['gaps'][number]['code']> = {
      responsibility: 'RESPONSIBILITY_UNKNOWN',
      entrypoints: 'ENTRYPOINT_UNKNOWN',
      contracts: 'CONTRACT_UNKNOWN',
      invariants: 'INVARIANT_UNKNOWN',
      dependencies: 'DEPENDENCY_UNKNOWN',
      consumers: 'CONSUMER_UNKNOWN',
      data_flow: 'DATA_FLOW_UNKNOWN',
      conventions: 'CONVENTION_UNKNOWN',
      tests: 'TEST_COVERAGE_UNKNOWN',
      operations: 'OPERATION_UNKNOWN',
      risks: 'RISK_UNKNOWN',
      placement: 'PLACEMENT_UNKNOWN',
    };
    const semanticModuleIds = new Set(
      inventory.files
        .filter(
          (file) =>
            allowedPaths.has(file.path) &&
            ['code', 'test', 'migration', 'script'].includes(file.kind),
        )
        .map((file) => file.module_id),
    );
    for (const moduleId of semanticModuleIds) {
      const moduleFiles = inventory.files.filter(
        (file) => file.module_id === moduleId && allowedPaths.has(file.path),
      );
      const assignedModulePaths = new Set(moduleFiles.map((file) => file.path));
      const applicable = new Set<(typeof categories)[number]>(['responsibility', 'conventions', 'placement']);
      if (moduleFiles.some((file) => file.kind === 'code' && file.exports.length > 0)) {
        applicable.add('entrypoints');
        applicable.add('contracts');
      }
      if (moduleFiles.some((file) => file.kind === 'code' && file.imports.length > 0)) applicable.add('dependencies');
      if (moduleFiles.some((file) => file.kind === 'test')) applicable.add('tests');
      if (moduleFiles.some((file) => file.kind === 'configuration' || file.kind === 'script')) applicable.add('operations');
      if (moduleFiles.some((file) => file.kind === 'migration')) applicable.add('data_flow');
      for (const category of categories) {
        const records = parsed.data.semantic_coverage.filter(
          (record) => record.module_id === moduleId && record.category === category,
        );
        if (records.length !== 1) {
          errors.push(
            `semantic coverage for ${moduleId}/${category} must have exactly one explicit disposition; received ${records.length}`,
          );
          continue;
        }
        const record = records[0]!;
        if (record.status === 'NOT_APPLICABLE' && applicable.has(category)) {
          errors.push(`${moduleId}/${category} is deterministically applicable and cannot be NOT_APPLICABLE`);
        }
        if (
          record.status === 'COVERED' &&
          !parsed.data.claims.some(
            (claim) =>
              claimKinds[category].includes(claim.kind) &&
              claim.evidence.some((evidence) => assignedModulePaths.has(evidence.path)),
          )
        ) {
          errors.push(`${moduleId}/${category} is COVERED without a matching primary semantic claim`);
        }
        if (
          record.status === 'GAP' &&
          !parsed.data.gaps.some(
            (gap) =>
              gap.code === gapCodes[category] &&
              gap.affected_paths.some((affected) => assignedModulePaths.has(affected)),
          )
        ) {
          errors.push(`${moduleId}/${category} is GAP without a matching factual gap`);
        }
      }
    }
    const unexpectedCoverage = parsed.data.semantic_coverage.filter(
      (record) => !parsed.data.module_ids.includes(record.module_id),
    );
    if (unexpectedCoverage.length > 0) {
      errors.push(
        `semantic coverage attributes modules outside the fragment: ${[
          ...new Set(unexpectedCoverage.map((record) => record.module_id)),
        ].join(', ')}`,
      );
    }
  }
  for (const gap of parsed.data.gaps) {
    for (const affectedPath of gap.affected_paths) {
      if (!allowedPaths.has(affectedPath)) {
        errors.push(`gap ${gap.code} cites path outside the exact assigned shard: ${affectedPath}`);
        receipt.rejected_evidence.push({ path: affectedPath, reason: 'gap path outside exact shard ownership' });
      }
    }
  }
  for (const claim of parsed.data.claims) {
    for (const ev of claim.evidence) {
      const entry = byPath.get(ev.path);
      if (!entry) {
        errors.push(`unmapped evidence path: ${ev.path}`);
        receipt.rejected_evidence.push({ path: ev.path, reason: 'unmapped evidence path' });
        continue;
      }
      const primary = allowedPaths.has(ev.path);
      const neighbor = neighborContractPaths.has(ev.path);
      if (!primary && !neighbor) {
        errors.push(`evidence path ${ev.path} is outside the exact assigned shard paths`);
        receipt.rejected_evidence.push({ path: ev.path, reason: 'outside exact shard ownership' });
        continue;
      }
      if (neighbor && ev.ownership !== 'external_contract') {
        errors.push(`neighbor contract ${ev.path} must be marked external_contract`);
        receipt.rejected_evidence.push({ path: ev.path, reason: 'neighbor contract not marked external_contract' });
        continue;
      }
      if (primary && ev.ownership === 'external_contract') {
        errors.push(`primary shard evidence ${ev.path} cannot be marked external_contract`);
        receipt.rejected_evidence.push({ path: ev.path, reason: 'primary evidence mislabeled external_contract' });
        continue;
      }
      if (neighbor && ['responsibility', 'placement'].includes(claim.kind)) {
        errors.push(`${claim.kind} claim cannot attribute ownership to neighbor contract ${ev.path}`);
        receipt.rejected_evidence.push({ path: ev.path, reason: `${claim.kind} attributed to external contract` });
        continue;
      }
      if (entry.file_hash !== ev.file_hash) {
        errors.push(`hash mismatch for ${ev.path}`);
        receipt.rejected_evidence.push({ path: ev.path, reason: 'hash mismatch' });
        continue;
      }
      const absolute = path.join(projectRoot, ev.path);
      if (!fs.existsSync(absolute) || sha256(fs.readFileSync(absolute)) !== ev.file_hash) {
        errors.push(`live file mismatch for ${ev.path}`);
        receipt.rejected_evidence.push({ path: ev.path, reason: 'live file mismatch' });
        continue;
      }
      if (ev.lines) {
        const [start, end = start] = ev.lines.split('-').map(Number);
        const count = fs.readFileSync(absolute, 'utf8').split(/\r?\n/).length;
        if (!start || !end || start > end || end > count) {
          errors.push(`invalid line range ${ev.lines} for ${ev.path} (${count} lines)`);
          receipt.rejected_evidence.push({ path: ev.path, reason: 'invalid line range' });
          continue;
        }
      }
      if (ev.symbol) {
        const fileText = fs.readFileSync(absolute, 'utf8');
        if (!evidenceSymbolExists(fileText, ev.symbol)) {
          errors.push(`symbol ${ev.symbol} not found in ${ev.path}`);
          receipt.rejected_evidence.push({ path: ev.path, reason: 'symbol not found' });
          continue;
        }
      }
      receipt.accepted_evidence.push({
        path: ev.path,
        ownership: neighbor ? 'external_contract' : 'primary',
      });
    }
  }
  return { fragment: errors.length === 0 ? parsed.data : null, errors, receipt };
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
    const evidencePaths = new Set(claim.evidence.map((item) => item.path));
    const unevidencedMentions = inventory.files
      .filter((file) => claim.statement.includes(file.path) && !evidencePaths.has(file.path))
      .map((file) => file.path);
    if (unevidencedMentions.length > 0) {
      errors.push(
        `claim ${index}: statement cites inventoried path(s) without evidence: ${unevidencedMentions.join(', ')}`,
      );
    }
    for (const ev of claim.evidence) {
      const entry = byPath.get(ev.path);
      if (!entry) errors.push(`claim ${index}: missing path ${ev.path}`);
      else if (entry.file_hash !== ev.file_hash) errors.push(`claim ${index}: hash mismatch ${ev.path}`);
      else if (!fs.existsSync(path.join(projectRoot, ev.path))) errors.push(`claim ${index}: path vanished ${ev.path}`);
    }
  }
  return errors;
}

export function validateUniqueAnalysisOwnership(
  receipts: Array<{
    shard_id: string;
    accepted_evidence: Array<{ path: string; ownership: 'primary' | 'external_contract' }>;
  }>,
): string[] {
  const owners = new Map<string, string>();
  const errors: string[] = [];
  for (const receipt of receipts) {
    for (const evidence of receipt.accepted_evidence) {
      if (evidence.ownership !== 'primary') continue;
      const owner = owners.get(evidence.path);
      if (owner && owner !== receipt.shard_id) {
        errors.push(`${evidence.path} has two analysis owners: ${owner} and ${receipt.shard_id}`);
      } else {
        owners.set(evidence.path, receipt.shard_id);
      }
    }
  }
  return errors;
}
