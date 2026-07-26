import { z } from 'zod';

export const CODEBASE_SCHEMA_VERSION = 1;
export const MAPPER_VERSION = '1.0.0';

export const EvidenceSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().min(1).optional(),
  // CLI hosts occasionally serialize a range as [start,end]. Normalize that
  // transport variation into the canonical stable "start-end" representation.
  lines: z.preprocess(
    (value) => {
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) return undefined;
      let range: unknown[] | null = Array.isArray(value) ? value : null;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        range = [record['start'], record['end'] ?? record['start']];
      }
      if (range && range.length >= 1 && range.length <= 2) {
        const numbers = range.map(Number);
        if (numbers.every((item) => Number.isInteger(item) && item > 0)) {
          return numbers.length === 1 || numbers[0] === numbers[1]
            ? String(numbers[0])
            : `${numbers[0]}-${numbers[1]}`;
        }
      }
      if (typeof value === 'string') {
        const normalized = value.trim().replace(/[–—]/g, '-').replace(/^L/i, '').replace(/-L/i, '-');
        if (/^\d+(?:-\d+)?$/.test(normalized)) return normalized;
      }
      // A line range is optional evidence enrichment. If a host emits another
      // transport shape, discard only the malformed range; path+sha256 remain
      // mandatory and are revalidated against the live file.
      return undefined;
    },
    z.string().regex(/^\d+(?:-\d+)?$/).optional(),
  ),
  file_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ExcludedPathSchema = z.object({
  path: z.string(),
  reason: z.enum([
    'sensitive',
    'vendor',
    'generated',
    'binary',
    'large_file',
    'rijo_artifact',
    'symlink',
    'unreadable',
  ]),
});
export type ExcludedPath = z.infer<typeof ExcludedPathSchema>;

export const InventoryKindSchema = z.enum([
  'code',
  'test',
  'configuration',
  'migration',
  'asset',
  'script',
  'documentation',
]);
export type InventoryKind = z.infer<typeof InventoryKindSchema>;

export const InventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: InventoryKindSchema,
  language: z.string().nullable(),
  bytes: z.number().int().nonnegative(),
  file_hash: z.string().regex(/^[a-f0-9]{64}$/),
  module_id: z.string().min(1),
  imports: z.array(z.string()).default([]),
  exports: z.array(z.string()).default([]),
});
export type CodebaseInventoryEntry = z.infer<typeof InventoryEntrySchema>;

export const CoverageSchema = z.object({
  relevant_files_classified: z.number().min(0).max(1).default(0),
  entrypoints_covered: z.number().min(0).max(1).default(0),
  modules_covered: z.number().min(0).max(1).default(0),
  public_contracts_covered: z.number().min(0).max(1).default(0),
  surfaces_covered: z.number().min(0).max(1).default(0),
  data_covered: z.number().min(0).max(1).default(0),
  tests_operations_covered: z.number().min(0).max(1).default(0),
  claims_verified: z.number().min(0).max(1).default(0),
});
export type CodebaseCoverage = z.infer<typeof CoverageSchema>;

export const InventoryDocumentSchema = z.object({
  schema_version: z.number().int().default(CODEBASE_SCHEMA_VERSION),
  files: z.array(InventoryEntrySchema),
  excluded_paths: z.array(ExcludedPathSchema),
  source_roots: z.array(z.string()).default([]),
  workspace_roots: z.array(z.string()).default([]),
  manifests: z.array(z.string()).default([]),
  lockfiles: z.array(z.string()).default([]),
  package_managers: z.array(z.string()).default([]),
  detected_commands: z.array(z.object({ category: z.string(), command: z.string(), source: z.string() })).default([]),
  coverage: CoverageSchema.default({}),
});
export type InventoryDocument = z.infer<typeof InventoryDocumentSchema>;

export const SymbolRecordSchema = z.object({
  name: z.string(),
  kind: z.enum(['function', 'class', 'interface', 'type', 'constant', 'command', 'route', 'unknown']),
  evidence: EvidenceSchema,
  module_id: z.string().optional(),
});
export const SymbolsDocumentSchema = z.object({
  schema_version: z.number().int().default(CODEBASE_SCHEMA_VERSION),
  symbols: z.array(SymbolRecordSchema),
});
export type SymbolsDocument = z.infer<typeof SymbolsDocumentSchema>;

export const SurfaceRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(['http', 'rpc', 'cli', 'ui_route', 'job', 'queue', 'event', 'webhook']),
  method: z.string().nullable().default(null),
  path: z.string(),
  evidence: EvidenceSchema,
  module_id: z.string(),
});
export const SurfacesDocumentSchema = z.object({
  schema_version: z.number().int().default(CODEBASE_SCHEMA_VERSION),
  surfaces: z.array(SurfaceRecordSchema),
});
export type SurfacesDocument = z.infer<typeof SurfacesDocumentSchema>;

export const DependencyModuleSchema = z.object({
  id: z.string(),
  paths: z.array(z.string()),
  dependencies: z.array(z.string()),
  consumers: z.array(z.string()).default([]),
});
export const DependencyGraphSchema = z.object({
  schema_version: z.number().int().default(CODEBASE_SCHEMA_VERSION),
  modules: z.array(DependencyModuleSchema),
});
export type DependencyGraph = z.infer<typeof DependencyGraphSchema>;

export const BaselineStatusSchema = z.enum([
  'DETECTED_NOT_RUN',
  'PASSED',
  'FAILED',
  'BLOCKED_BY_SANDBOX',
  'NOT_AVAILABLE',
  'WAIVED',
]);
export type BaselineStatus = z.infer<typeof BaselineStatusSchema>;

export const BaselineCommandSchema = z.object({
  category: z.string(),
  command: z.string(),
  source: z.string(),
  status: BaselineStatusSchema,
  commit: z.string().nullable(),
  tree_hash: z.string().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  exit_code: z.number().int().nullable(),
  output: z.string(),
  sandbox: z.string().nullable(),
});
export const BaselineDocumentSchema = z.object({
  schema_version: z.number().int().default(CODEBASE_SCHEMA_VERSION),
  overall_status: BaselineStatusSchema,
  commands: z.array(BaselineCommandSchema),
});
export type BaselineDocument = z.infer<typeof BaselineDocumentSchema>;

export const HistoryRecordSchema = z.object({
  commits_analyzed: z.number().int().nonnegative(),
  renames: z.array(z.object({ from: z.string(), to: z.string(), commit: z.string() })),
  churn: z.array(z.object({ path: z.string(), changes: z.number().int().nonnegative() })),
  cochange: z.array(z.object({ paths: z.array(z.string()), commits: z.number().int().nonnegative() })),
  architectural_commits: z.array(z.object({ commit: z.string(), subject: z.string(), paths: z.array(z.string()) })),
  migrations: z.array(z.object({ path: z.string(), commit: z.string() })),
  hotspots: z.array(z.object({ path: z.string(), score: z.number().nonnegative(), reasons: z.array(z.string()) })),
});
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

const CLAIM_KIND_ALIASES: Record<string, string> = {
  module: 'responsibility',
  architecture: 'responsibility',
  public_contract: 'contract',
  api: 'contract',
  test: 'operation',
  testing: 'operation',
  operations: 'operation',
  devops: 'operation',
  integration: 'contract',
  security: 'risk',
  concern: 'risk',
  debt: 'risk',
  performance: 'risk',
  data: 'data_flow',
  dataflow: 'data_flow',
};

export const MapClaimSchema = z.object({
  kind: z.preprocess(
    (value) => (typeof value === 'string' ? (CLAIM_KIND_ALIASES[value.toLowerCase()] ?? value.toLowerCase()) : value),
    z.enum(['responsibility', 'contract', 'invariant', 'risk', 'convention', 'operation', 'data_flow']),
  ),
  statement: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
});
export type MapClaim = z.infer<typeof MapClaimSchema>;

export const ClaimsDocumentSchema = z.object({
  schema_version: z.number().int().default(CODEBASE_SCHEMA_VERSION),
  claims: z.array(MapClaimSchema),
});
export type ClaimsDocument = z.infer<typeof ClaimsDocumentSchema>;

export const MapAgentFragmentSchema = z.object({
  shard_id: z.string(),
  module_ids: z.array(z.string()).min(1),
  claims: z.array(MapClaimSchema),
  gaps: z.array(z.string()).default([]),
});
export type MapAgentFragment = z.infer<typeof MapAgentFragmentSchema>;

export const MapReviewSchema = z.object({
  approved: z.boolean(),
  findings: z.array(
    z.object({
      code: z.enum(['MISSING_EVIDENCE', 'BAD_PATH', 'BAD_HASH', 'BAD_SYMBOL', 'CONTRADICTION', 'COVERAGE_GAP']),
      message: z.string(),
      evidence: z.array(EvidenceSchema).default([]),
    }),
  ),
});

export const MapStateSchema = z.object({
  schema_version: z.number().int().default(CODEBASE_SCHEMA_VERSION),
  mapper_version: z.string(),
  status: z.enum(['COMPLETE', 'PARTIAL', 'BLOCKED']),
  mapped_commit: z.string(),
  mapped_tree_hash: z.string(),
  mapped_at: z.string(),
  branch: z.string(),
  source_roots: z.array(z.string()),
  module_ids: z.array(z.string()),
  file_count: z.number().int().nonnegative(),
  coverage: CoverageSchema,
  excluded_paths: z.array(ExcludedPathSchema),
  artifact_hashes: z.record(z.string(), z.string()),
  baseline_status: BaselineStatusSchema,
  changed_paths_since_map: z.array(z.string()),
  stale_reasons: z.array(z.string()),
  gaps: z.array(z.string()).default([]),
  last_operation: z.enum(['full', 'incremental', 'paths', 'no-op']).default('full'),
});
export type CodebaseMapState = z.infer<typeof MapStateSchema>;
