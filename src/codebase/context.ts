import * as fs from 'node:fs';
import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { readJsonIfExists, readTextIfExists, sha256 } from '../core/fsx.js';
import {
  DependencyGraphSchema,
  ClaimsDocumentSchema,
  InventoryDocumentSchema,
  MapStateSchema,
  type MapGap,
  SurfacesDocumentSchema,
  SymbolsDocumentSchema,
} from './schemas.js';
import type { PhasePlanDraft } from '../core/schemas/index.js';

export interface CodebaseContextPacket {
  text: string;
  bytes: number;
  files_loaded: string[];
  selected_modules: string[];
  selected_paths: string[];
  selected_symbols: string[];
  selected_decisions: string[];
  selected_gaps: string[];
  freshness: string;
  packet_hash: string;
  mapped_commit: string;
  mapped_tree_hash: string;
  decision_context_hash: string;
  generated_at: string;
}

export interface PlanMapReferenceIssue {
  code:
    | 'MAP_PATH_NOT_FOUND'
    | 'MAP_HASH_MISMATCH'
    | 'MAP_SYMBOL_NOT_FOUND'
    | 'MAP_INTENT_MISMATCH'
    | 'MAP_REFERENCE_MISSING'
    | 'MAP_PARENT_MODULE_NOT_FOUND'
    | 'MAP_PLACEMENT_INVALID'
    | 'MAP_PLACEMENT_EVIDENCE_INVALID'
    | 'MAP_WRITE_SCOPE_WIDER';
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

export function structuredGapsAffectingScope(gaps: MapGap[], scopeText: string): string[] {
  const scopeTerms = terms(scopeText);
  return gaps
    .filter((gap) => {
      if (gap.severity === 'critical') return true;
      if (gap.affected_paths.length === 0 && gap.affected_modules.length === 0) {
        return score(gap.message, scopeTerms) > 0;
      }
      return (
        gap.affected_paths.some((candidate) => {
          const normalized = candidate.toLowerCase();
          const basename = path.posix.basename(normalized, path.posix.extname(normalized));
          return scopeText.toLowerCase().includes(normalized) || (basename.length >= 3 && scopeTerms.has(basename));
        }) ||
        gap.affected_modules.some((module) =>
          module
            .toLowerCase()
            .split('/')
            .some((part) => part.length >= 3 && scopeTerms.has(part)),
        )
      );
    })
    .map(
      (gap) =>
        `${gap.code}/${gap.severity}: ${gap.message}${
          gap.affected_paths.length > 0 ? ` (${gap.affected_paths.join(', ')})` : ''
        }`,
    );
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

export function buildContextPacket(
  projectRoot: string,
  planText: string,
  budgetBytes: number,
  now: () => Date = () => new Date(),
): CodebaseContextPacket {
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
  const architecture = loadText('ARCHITECTURE.md');
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
    return {
      text,
      bytes: Buffer.byteLength(text),
      files_loaded: loaded.filter((p) => fs.existsSync(p)),
      selected_modules: [],
      selected_paths: [],
      selected_symbols: [],
      selected_decisions: [],
      selected_gaps: [],
      freshness: 'invalid',
      packet_hash: sha256(text),
      mapped_commit: '',
      mapped_tree_hash: '',
      decision_context_hash: sha256(''),
      generated_at: now().toISOString(),
    };
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
  const contractRows = selectedClaims.filter((claim) => claim.kind === 'contract' || claim.kind === 'entrypoint');
  const riskRows = selectedClaims.filter((claim) => claim.kind === 'risk');
  const testRows = files.filter((file) => file.kind === 'test');
  const freshness = `${state.data.status} @ ${state.data.mapped_commit} (${state.data.mapped_at})`;
  const selectedDecisionIds = [...decisions.matchAll(/^##\s+([^\s]+).*$/gm)].map((match) => match[1]!);
  const selectedGapRecords = state.data.gap_records.filter(
    (gap) =>
      gap.affected_paths.length === 0 ||
      gap.affected_paths.some((affected) => selectedPaths.has(affected)) ||
      gap.affected_modules.some((affected) => selected.includes(affected)) ||
      score(`${gap.code} ${gap.message}`, wanted) > 0,
  );
  const selectedGaps = [
    ...state.data.gaps,
    ...selectedGapRecords.map(
      (gap) =>
        `${gap.code}/${gap.severity}: ${gap.message}${
          gap.affected_paths.length > 0 ? ` (${gap.affected_paths.join(', ')})` : ''
        }`,
    ),
  ];
  const placementRules = graphRows.map((module) => {
    const roots = [...new Set(module.paths.map((item) => path.posix.dirname(item)))].sort();
    return `- ${module.id}: new files must extend ${roots.join(', ') || 'an explicitly mapped module root'}`;
  });
  const parts = [
    'CODEBASE MAP CONTEXT (deterministic local query; use cited existing paths/symbols, do not invent them)',
    `Freshness: ${freshness}`,
    summary.trim(),
    `Relevant architecture:\n${clip(architecture) || '- No separate architecture artifact for the selected scope.'}`,
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
    `Freshness gaps:\n${selectedGaps.length ? selectedGaps.map((gap) => `- ${gap}`).join('\n') : '- none'}`,
    `Related tests:\n${testRows.length ? testRows.map((file) => `- ${file.path}`).join('\n') : '- none detected'}`,
    `Related modules:\n${graphRows
      .map((m) => `- ${m.id}: paths=${m.paths.join(', ')} dependencies=${m.dependencies.join(', ') || 'none'} consumers=${m.consumers.join(', ') || 'none'}`)
      .join('\n')}`,
    `Related surfaces:\n${surfaceRows.map((s) => `- ${s.kind} ${s.method ?? ''} ${s.path} — ${s.evidence.path}`).join('\n')}`,
    `Placement rules for new files:\n${placementRules.join('\n') || '- No safe placement rule was mapped.'}`,
  ].filter((p) => p.trim() !== '');
  let text = boundedJoin(parts, budgetBytes);
  while (Buffer.byteLength(text) > budgetBytes && text.length > 0) text = text.slice(0, -1);
  const selectedPathList = [...selectedPaths].sort();
  const selectedSymbolList = symbolRows.map((symbol) => symbol.name).sort();
  const decisionContextHash = sha256(decisions);
  const packetHash = sha256(
    JSON.stringify({
      text,
      mapped_commit: state.data.mapped_commit,
      mapped_tree_hash: state.data.mapped_tree_hash,
      selected_modules: selected,
      selected_paths: selectedPathList,
      selected_symbols: selectedSymbolList,
      selected_decisions: selectedDecisionIds,
      selected_gaps: selectedGaps,
      source_context: {
        summary,
        architecture,
        conventions,
        baselineText,
        concerns,
        decisions,
        gap_records: selectedGapRecords,
      },
    }),
  );
  return {
    text,
    bytes: Buffer.byteLength(text),
    files_loaded: loaded.filter((p) => fs.existsSync(p)),
    selected_modules: selected,
    selected_paths: selectedPathList,
    selected_symbols: selectedSymbolList,
    selected_decisions: selectedDecisionIds,
    selected_gaps: selectedGaps,
    freshness,
    packet_hash: packetHash,
    mapped_commit: state.data.mapped_commit,
    mapped_tree_hash: state.data.mapped_tree_hash,
    decision_context_hash: decisionContextHash,
    generated_at: now().toISOString(),
  };
}

/**
 * Reject fabricated references deterministically. Existing files named by a
 * task must be backed by a current inventory hash; symbols must also exist in
 * symbols.json at that path. Non-existing task files are treated as proposed
 * additions only when their parent directory is real.
 */
export function validatePlanMapReferences(projectRoot: string, plan: PhasePlanDraft): PlanMapReferenceIssue[] {
  const paths = new RijoPaths(projectRoot);
  const inventory = InventoryDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'inventory.json')));
  const symbols = SymbolsDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'symbols.json')));
  const graph = DependencyGraphSchema.safeParse(
    readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'dependency-graph.json')),
  );
  const claims = ClaimsDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'claims.json')));
  if (!inventory.success || !symbols.success || !graph.success) {
    return plan.tasks.map((task) => ({
      code: 'MAP_PATH_NOT_FOUND',
      task_id: task.id,
      message: 'the current codebase inventory, symbols, or dependency graph is unavailable',
    }));
  }

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
    const normalizedFiles = new Set(task.files.map(normalizeProjectPath));
    const referencesByPath = new Map(task.mapped_references.map((reference) => [normalizeProjectPath(reference.path), reference]));
    for (const file of normalizedFiles) {
      if (!referencesByPath.has(file)) {
        issues.push({
          code: 'MAP_REFERENCE_MISSING',
          task_id: task.id,
          message: `${file} has no explicit existing/new mapped reference`,
        });
      }
    }
    for (const reference of task.mapped_references) {
      const referencePath = normalizeProjectPath(reference.path);
      const entry = byPath.get(referencePath);
      if (reference.intent === 'existing' && !entry) {
        issues.push({
          code: 'MAP_INTENT_MISMATCH',
          task_id: task.id,
          message: `${referencePath} is declared existing but is absent from the current inventory`,
        });
        continue;
      }
      if (reference.intent === 'new' && entry) {
        issues.push({
          code: 'MAP_INTENT_MISMATCH',
          task_id: task.id,
          message: `${referencePath} already exists and cannot be declared new`,
        });
        continue;
      }
      if (reference.intent === 'existing' && entry!.file_hash !== reference.file_hash) {
        issues.push({
          code: 'MAP_HASH_MISMATCH',
          task_id: task.id,
          message: `${referencePath} hash does not match the current map`,
        });
      }
      if (reference.intent === 'existing' && reference.symbol && !symbolKeys.has(`${referencePath}\0${reference.symbol}`)) {
        issues.push({
          code: 'MAP_SYMBOL_NOT_FOUND',
          task_id: task.id,
          message: `${reference.symbol} is not mapped at ${referencePath}`,
        });
      }
      if (reference.intent === 'new') {
        const owner = graph.data.modules.find((module) => module.id === reference.parent_module);
        if (!owner) {
          issues.push({
            code: 'MAP_PARENT_MODULE_NOT_FOUND',
            task_id: task.id,
            message: `${reference.parent_module} is not a mapped module`,
          });
          continue;
        }
        const ownerRoots = [...new Set(owner.paths.map((item) => path.posix.dirname(item)))];
        const destinationDir = path.posix.dirname(referencePath);
        const compatible = ownerRoots.some(
          (root) => destinationDir === root || destinationDir.startsWith(`${root}/`),
        );
        if (!compatible) {
          issues.push({
            code: 'MAP_PLACEMENT_INVALID',
            task_id: task.id,
            message: `${referencePath} does not extend the mapped architecture of ${reference.parent_module}`,
          });
        }
        for (const evidence of reference.placement_evidence) {
          const evidencePath = normalizeProjectPath(evidence.path);
          const evidenceOwned =
            owner.paths.includes(evidencePath) ||
            ownerRoots.some((root) => evidencePath === root || evidencePath.startsWith(`${root}/`));
          const absolute = path.resolve(projectRoot, evidencePath);
          if (!evidenceOwned || !insideProject(projectRoot, absolute) || !fs.existsSync(absolute)) {
            issues.push({
              code: 'MAP_PLACEMENT_EVIDENCE_INVALID',
              task_id: task.id,
              message: `${evidencePath} is not real placement evidence owned by ${reference.parent_module}`,
            });
          }
        }
      }
    }
    for (const file of task.files) {
      const normalized = normalizeProjectPath(file);
      const absolute = path.resolve(projectRoot, normalized);
      if (!insideProject(projectRoot, absolute)) {
        issues.push({
          code: 'MAP_PATH_NOT_FOUND',
          task_id: task.id,
          message: `${normalized} escapes the project and cannot be a mapped or new file`,
        });
      }
    }
    for (const scope of task.write_scope) {
      const normalized = normalizeProjectPath(scope);
      if (!normalizedFiles.has(normalized)) {
        issues.push({
          code: 'MAP_WRITE_SCOPE_WIDER',
          task_id: task.id,
          message: `${normalized} is in write_scope but is not an explicitly declared task file`,
        });
      }
    }
  }
  return issues;
}

function normalizeProjectPath(value: string): string {
  return value.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function insideProject(projectRoot: string, absolute: string): boolean {
  const relative = path.relative(path.resolve(projectRoot), absolute);
  return relative !== '' && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..');
}
