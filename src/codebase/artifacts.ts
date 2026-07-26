import * as path from 'node:path';
import { sha256 } from '../core/fsx.js';
import {
  CODEBASE_SCHEMA_VERSION,
  MAPPER_VERSION,
  MapStateSchema,
  type BaselineDocument,
  type CodebaseMapState,
  type DependencyGraph,
  type HistoryRecord,
  type InventoryDocument,
  type MapClaim,
  type SurfacesDocument,
  type SymbolsDocument,
} from './schemas.js';

export interface MapArtifactInput {
  inventory: InventoryDocument;
  symbols: SymbolsDocument;
  graph: DependencyGraph;
  surfaces: SurfacesDocument;
  history: HistoryRecord;
  baseline: BaselineDocument;
  claims: MapClaim[];
  gaps: string[];
  commit: string;
  branch: string;
  sourceTreeHash: string;
  mappedAt: string;
  changedPaths: string[];
  staleReasons: string[];
  operation: CodebaseMapState['last_operation'];
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

function evidenceRefs(claim: MapClaim): string {
  return claim.evidence
    .map((ev) => `\`${ev.path}\`${ev.symbol ? ` (\`${ev.symbol}\`)` : ''}${ev.lines ? ` lines ${ev.lines}` : ''}`)
    .join(', ');
}

function moduleFiles(inventory: InventoryDocument, id: string): InventoryDocument['files'] {
  return inventory.files.filter((file) => file.module_id === id);
}

function stackMarkdown(input: MapArtifactInput): string {
  const languages = new Map<string, number>();
  for (const file of input.inventory.files) {
    if (file.language) languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
  }
  const refs = input.inventory.manifests.length ? input.inventory.manifests : input.inventory.files.slice(0, 1).map((f) => f.path);
  return [
    '# Stack',
    '',
    '## Languages',
    ...[...languages.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `- ${name}: ${count} mapped files.`),
    '',
    '## Package and workspace signals',
    `- Package managers: ${input.inventory.package_managers.join(', ') || 'not detected'}. Evidence: ${refs.map((p) => `\`${p}\``).join(', ') || 'none'}.`,
    `- Manifests: ${input.inventory.manifests.map((p) => `\`${p}\``).join(', ') || 'none'}.`,
    `- Lockfiles: ${input.inventory.lockfiles.map((p) => `\`${p}\``).join(', ') || 'none'}.`,
    `- Workspace roots: ${input.inventory.workspace_roots.map((p) => `\`${p}\``).join(', ') || 'single-package layout'}.`,
    '',
    '## Detected commands (not run by detection)',
    ...(input.inventory.detected_commands.length
      ? input.inventory.detected_commands.map((c) => `- \`${c.command}\` (${c.category}), detected in \`${c.source}\`.`)
      : ['- No supported command was detected.']),
    '',
  ].join('\n');
}

function modulesMarkdown(input: MapArtifactInput): string {
  const claimByModule = (id: string) =>
    input.claims.filter((claim) => claim.evidence.some((ev) => moduleFiles(input.inventory, id).some((file) => file.path === ev.path)));
  const lines = ['# Modules', ''];
  for (const module of input.graph.modules) {
    const files = moduleFiles(input.inventory, module.id);
    const entrypoints = files.filter((file) => /(^|\/)(index|main|app|server|cli)\.[^.]+$/.test(file.path));
    const contracts = files.filter((file) => file.exports.length > 0);
    const tests = input.inventory.files.filter(
      (file) =>
        file.kind === 'test' &&
        (file.path.toLowerCase().includes(module.id.split('/').at(-1)!.toLowerCase()) ||
          file.imports.some((item) => files.some((candidate) => item.includes(path.posix.basename(candidate.path, path.posix.extname(candidate.path)))))),
    );
    const claims = claimByModule(module.id);
    lines.push(
      `## ${module.id}`,
      '',
      `- Responsibility: owns the mapped files ${files.slice(0, 12).map((f) => `\`${f.path}\``).join(', ')}${files.length > 12 ? ` and ${files.length - 12} more` : ''}.`,
      `- Entrypoints: ${entrypoints.map((f) => `\`${f.path}\``).join(', ') || 'no conventional entrypoint detected'}.`,
      `- Public contracts: ${contracts
        .flatMap((f) => f.exports.map((symbol) => `\`${symbol}\` in \`${f.path}\``))
        .slice(0, 25)
        .join(', ') || 'no exported symbol detected'}.`,
      `- Dependencies: ${module.dependencies.join(', ') || 'none detected'}.`,
      `- Consumers: ${module.consumers.join(', ') || 'none detected'}.`,
      `- Invariants and evidence: ${claims.map((claim) => `${claim.statement} (${evidenceRefs(claim)})`).join(' ') || 'no additional mapper claim'}.`,
      `- Tests: ${tests.map((f) => `\`${f.path}\``).join(', ') || 'no directly-associated test detected'}.`,
      `- Risks: ${input.history.hotspots.filter((h) => files.some((f) => f.path === h.path)).map((h) => `\`${h.path}\` (${h.reasons.join('; ')})`).join(', ') || 'no history hotspot in sampled commits'}.`,
      `- Correct location for new work: preserve this boundary and add files beside ${entrypoints[0] ? `\`${entrypoints[0].path}\`` : `\`${files[0]?.path ?? module.id}\``} unless a mapped contract requires another owner.`,
      '',
    );
  }
  return lines.join('\n');
}

function surfacesMarkdown(input: MapArtifactInput): string {
  return [
    '# APIs and Public Surfaces',
    '',
    ...(input.surfaces.surfaces.length
      ? input.surfaces.surfaces.map(
          (surface) =>
            `- **${surface.kind}** ${surface.method ?? ''} \`${surface.path}\` — \`${surface.evidence.path}\`${surface.evidence.lines ? ` lines ${surface.evidence.lines}` : ''}.`,
        )
      : ['- No HTTP, RPC, CLI, UI route, job, queue, event, or webhook surface was deterministically detected.']),
    '',
  ].join('\n');
}

function baselineMarkdown(baseline: BaselineDocument): string {
  return [
    '# Brownfield Baseline',
    '',
    `Overall status: **${baseline.overall_status}**.`,
    '',
    ...(baseline.commands.length
      ? baseline.commands.map(
          (command) =>
            `- \`${command.command}\` — **${command.status}**; source \`${command.source}\`; exit ${command.exit_code ?? 'not run'}; duration ${command.duration_ms ?? 'n/a'} ms; sandbox ${command.sandbox ?? 'n/a'}.`,
        )
      : ['- No supported baseline command was available.']),
    '',
    'Commands are never described as verified unless their status is PASSED and an exit code is present.',
    '',
  ].join('\n');
}

export function buildMapArtifacts(input: MapArtifactInput): { artifacts: Record<string, string>; state: CodebaseMapState } {
  const modules = input.graph.modules;
  const firstEvidence = input.inventory.files[0]?.path ?? 'no mapped file';
  const tests = input.inventory.files.filter((file) => file.kind === 'test');
  const migrations = input.inventory.files.filter((file) => file.kind === 'migration');
  const configs = input.inventory.files.filter((file) => file.kind === 'configuration');
  const operations = input.inventory.files.filter(
    (file) => file.kind === 'script' || /Dockerfile|\.github\/|deploy|infra/i.test(file.path),
  );
  const artifacts: Record<string, string> = {
    'SUMMARY.md': [
      '# Codebase Summary',
      '',
      `Mapped ${input.inventory.files.length} relevant files across ${modules.length} modules at commit \`${input.commit}\`.`,
      `Primary source roots: ${input.inventory.source_roots.map((p) => `\`${p}\``).join(', ') || 'none'}.`,
      `Public surfaces: ${input.surfaces.surfaces.length}; exported symbols: ${input.symbols.symbols.length}; sampled Git commits: ${input.history.commits_analyzed}.`,
      `Baseline: ${input.baseline.overall_status}. Coverage claims are validated against real paths and hashes.`,
      `Start with \`MODULES.md\` for ownership and \`APIS.md\` for contracts. Inventory evidence begins at \`${firstEvidence}\`.`,
      '',
    ].join('\n'),
    'STACK.md': stackMarkdown(input),
    'ARCHITECTURE.md': [
      '# Architecture',
      '',
      'The module graph below is derived from real file ownership and relative imports.',
      '',
      ...modules.map(
        (module) =>
          `- **${module.id}**: ${module.paths.slice(0, 8).map((p) => `\`${p}\``).join(', ')}; depends on ${module.dependencies.join(', ') || 'none'}; consumed by ${module.consumers.join(', ') || 'none'}.`,
      ),
      '',
      'Cross-cutting mapper claims:',
      ...input.claims.map((claim) => `- ${claim.statement} Evidence: ${evidenceRefs(claim)}.`),
      '',
    ].join('\n'),
    'STRUCTURE.md': [
      '# Structure',
      '',
      ...modules.map((module) => `- **${module.id}** → ${module.paths.map((p) => `\`${p}\``).join(', ')}`),
      '',
      'Every relevant file is assigned to exactly one module in `inventory.json`; excluded roots carry explicit reasons there.',
      '',
    ].join('\n'),
    'MODULES.md': modulesMarkdown(input),
    'CONVENTIONS.md': [
      '# Conventions',
      '',
      ...input.claims
        .filter((claim) => claim.kind === 'convention' || claim.kind === 'invariant')
        .map((claim) => `- ${claim.statement} Evidence: ${evidenceRefs(claim)}.`),
      `- Preserve the dominant module ownership recorded in \`MODULES.md\`; representative evidence: \`${firstEvidence}\`.`,
      `- Public names are extracted from actual exports in ${input.inventory.files.filter((f) => f.exports.length).slice(0, 10).map((f) => `\`${f.path}\``).join(', ') || `\`${firstEvidence}\``}.`,
      '',
    ].join('\n'),
    'TESTING.md': [
      '# Testing',
      '',
      `Mapped test files: ${tests.map((file) => `\`${file.path}\``).join(', ') || 'none detected'}.`,
      '',
      'Detected commands are evidence of availability only; execution state is recorded in `BASELINE.md` and `baseline.json`.',
      ...input.baseline.commands.filter((c) => c.category.includes('test')).map((c) => `- \`${c.command}\` — ${c.status}; detected in \`${c.source}\`.`),
      '',
    ].join('\n'),
    'APIS.md': surfacesMarkdown(input),
    'DATA.md': [
      '# Data',
      '',
      `Migrations: ${migrations.map((file) => `\`${file.path}\``).join(', ') || 'none detected'}.`,
      `Models/schema candidates: ${input.inventory.files.filter((f) => /(^|\/)(models?|schemas?|db)(\/|$)/i.test(f.path)).map((f) => `\`${f.path}\``).join(', ') || 'none detected'}.`,
      'Ownership follows the module assigned to each path in `inventory.json`; flows crossing modules appear in `dependency-graph.json`.',
      '',
    ].join('\n'),
    'INTEGRATIONS.md': [
      '# Integrations',
      '',
      `Manifest evidence: ${input.inventory.manifests.map((p) => `\`${p}\``).join(', ') || 'none'}.`,
      ...input.inventory.files
        .filter((file) => file.imports.some((name) => !name.startsWith('.')))
        .slice(0, 50)
        .map((file) => `- \`${file.path}\` imports external packages: ${file.imports.filter((name) => !name.startsWith('.')).join(', ')}.`),
      '',
    ].join('\n'),
    'OPERATIONS.md': [
      '# Operations',
      '',
      `Operational files: ${operations.map((file) => `\`${file.path}\``).join(', ') || 'none detected'}.`,
      `Configuration files: ${configs.slice(0, 50).map((file) => `\`${file.path}\``).join(', ') || 'none detected'}.`,
      ...input.inventory.detected_commands.map((command) => `- Detected \`${command.command}\` in \`${command.source}\`; baseline status: ${input.baseline.commands.find((c) => c.command === command.command)?.status ?? 'DETECTED_NOT_RUN'}.`),
      '',
    ].join('\n'),
    'HISTORY.md': [
      '# History',
      '',
      `Sampled commits: ${input.history.commits_analyzed}. Historical facts are kept separate from current architecture.`,
      '',
      '## Renames and moves',
      ...(input.history.renames.length
        ? input.history.renames.map((r) => `- \`${r.from}\` → \`${r.to}\` in \`${r.commit}\`.`)
        : ['- No rename was found in the sampled history.']),
      '',
      '## High churn',
      ...input.history.churn.slice(0, 30).map((c) => `- \`${c.path}\`: ${c.changes} sampled commits.`),
      '',
      '## Architectural commits',
      ...input.history.architectural_commits.map((c) => `- \`${c.commit}\` ${c.subject}; paths: ${c.paths.map((p) => `\`${p}\``).join(', ')}.`),
      '',
    ].join('\n'),
    'CONCERNS.md': [
      '# Concerns',
      '',
      '## History-backed hotspots',
      ...(input.history.hotspots.length
        ? input.history.hotspots.map((h) => `- \`${h.path}\` — score ${h.score}: ${h.reasons.join('; ')}.`)
        : ['- No hotspot was established from the sampled history.']),
      '',
      '## Coverage and gaps',
      ...input.gaps.map((gap) => `- ${gap}`),
      `- Exclusions are explicit in \`inventory.json\`; sensitive paths (${input.inventory.excluded_paths.filter((e) => e.reason === 'sensitive').length}) were never read.`,
      '',
    ].join('\n'),
    'BASELINE.md': baselineMarkdown(input.baseline),
    'inventory.json': json(input.inventory),
    'symbols.json': json(input.symbols),
    'dependency-graph.json': json(input.graph),
    'surfaces.json': json(input.surfaces),
    'claims.json': json({ schema_version: CODEBASE_SCHEMA_VERSION, claims: input.claims }),
    'baseline.json': json(input.baseline),
  };
  const artifactHashes = Object.fromEntries(Object.entries(artifacts).map(([name, body]) => [name, sha256(body)]));
  const state = MapStateSchema.parse({
    schema_version: CODEBASE_SCHEMA_VERSION,
    mapper_version: MAPPER_VERSION,
    status: 'COMPLETE',
    mapped_commit: input.commit,
    mapped_tree_hash: input.sourceTreeHash,
    mapped_at: input.mappedAt,
    branch: input.branch,
    source_roots: input.inventory.source_roots,
    module_ids: input.graph.modules.map((module) => module.id),
    file_count: input.inventory.files.length,
    coverage: input.inventory.coverage,
    excluded_paths: input.inventory.excluded_paths,
    artifact_hashes: artifactHashes,
    baseline_status: input.baseline.overall_status,
    changed_paths_since_map: input.changedPaths,
    stale_reasons: input.staleReasons,
    gaps: input.gaps,
    last_operation: input.operation,
  });
  artifacts['map-state.json'] = json(state);
  return { artifacts, state };
}

export function sourceTreeHash(inventory: InventoryDocument): string {
  return sha256(inventory.files.map((file) => `${file.path}\0${file.file_hash}`).sort().join('\n'));
}
