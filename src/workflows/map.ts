import * as fs from 'node:fs';
import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { exists, readJsonIfExists, sha256 } from '../core/fsx.js';
import { MilestoneTransaction } from '../core/txn.js';
import { snapshotTree, diffTrees } from '../core/workspace.js';
import type { AgentTaskDraft } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  blockedReadOnly,
  completed,
  failed,
  dispatchBatch,
  dispatch,
  replaceableAttempt,
  guardSchema,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';
import { buildInventory, MapPreflightError } from '../codebase/inventory.js';
import {
  buildDependencyGraph,
  deterministicClaims,
  extractSurfaces,
  extractSymbols,
  partitionInventory,
  validateClaims,
  validateFragmentDetailed,
} from '../codebase/analyze.js';
import {
  collectGitHistory,
  dirtyApplicationPaths,
  gitDrift,
  resolveRepositoryMetadata,
  sameFilesystemPath,
} from '../codebase/git.js';
import { runBaseline } from '../codebase/baseline.js';
import { buildMapArtifacts, sourceTreeHash } from '../codebase/artifacts.js';
import {
  BaselineDocumentSchema,
  ClaimsDocumentSchema,
  MapReviewSchema,
  MapStateSchema,
  type BaselineDocument,
  type CodebaseMapState,
  type MapClaim,
} from '../codebase/schemas.js';
import { clearStaleMarker, readMapState, readStaleMarker } from '../codebase/state.js';

export interface MapOptions {
  full?: boolean;
  paths?: string[];
  query?: string;
  status?: boolean;
}

export interface MapCoreOptions extends MapOptions {
  /** Called from `new` while its lock is already held: never acquire/commit a second lifecycle. */
  nested?: boolean;
  commit?: boolean;
  allowedDirtyPaths?: string[];
}

export interface CodebaseQueryMatch {
  source: string;
  key: string;
  path: string | null;
  snippet: string;
}

export interface CodebaseQueryResult {
  term: string;
  matches: CodebaseQueryMatch[];
  model_calls: 0;
}

const SAFE_SCOPE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

function normalizedScopes(raw: string[] = []): string[] {
  const out = raw.map((value) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  const invalid = out.filter((value) => !SAFE_SCOPE.test(value));
  if (invalid.length > 0) throw new Error(`Unsafe map path scope: ${invalid.join(', ')}`);
  return [...new Set(out)].sort();
}

function rel(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function authorizedRijoIgnore(): string {
  return ['runtime/', 'events.jsonl', 'archive/', ''].join('\n');
}

export async function mapWorkflow(
  projectRoot: string,
  options: MapOptions = {},
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const metadata = resolveRepositoryMetadata(projectRoot);
  const ctx = createContext(metadata.root, deps);
  if (options.query !== undefined) {
    const result = queryCodebaseMap(metadata.root, options.query);
    return completed(ctx, `Map query returned ${result.matches.length} deterministic match(es).`, [
      JSON.stringify(result),
    ]);
  }
  if (options.status) {
    const status = readCodebaseMapStatus(metadata.root);
    return status
      ? completed(ctx, `Map status: ${status.status} (${status.freshness}).`, [JSON.stringify(status)])
      : failed(ctx, 'No codebase map exists.');
  }
  return withLock(ctx, () => mapCore(ctx, { ...options, commit: true }));
}

export async function ensureCodebaseMap(
  ctx: WorkflowContext,
  options: Omit<MapCoreOptions, 'nested'> = {},
): Promise<{ outcome: WorkflowOutcome; state: CodebaseMapState | null }> {
  const outcome = await mapCore(ctx, { ...options, nested: true, commit: false });
  return { outcome, state: readMapState(ctx.paths) };
}

export async function mapCore(ctx: WorkflowContext, options: MapCoreOptions = {}): Promise<WorkflowOutcome> {
  const { projectRoot, paths, bus, now } = ctx;
  const schemaGuard = guardSchema(ctx);
  if (schemaGuard) return schemaGuard;

  bus.emit('map.preflight', {
    status: 'running',
    stage: 'MAP_PREFLIGHT',
    message: 'validando raiz, checkout, symlinks e freshness',
  });
  const metadata = resolveRepositoryMetadata(projectRoot);
  if (!sameFilesystemPath(metadata.root, fs.realpathSync(projectRoot))) {
    return blocked(ctx, 'Map must run from the real repository root.', [`Resolved root: ${metadata.root}`]);
  }
  if (metadata.is_repo) {
    const dirty = dirtyApplicationPaths(projectRoot, options.allowedDirtyPaths);
    if (dirty.length > 0) {
      return blockedReadOnly(ctx, 'Codebase mapping requires a clean checkout.', [
        `Dirty paths: ${dirty.slice(0, 30).join(', ')}`,
        'Only RIJO runtime/events/archive paths are ignored.',
      ]);
    }
  }

  let scopes: string[];
  try {
    scopes = normalizedScopes(options.paths);
  } catch (error) {
    return failed(ctx, (error as Error).message);
  }

  let inventory;
  try {
    bus.emit('map.inventory', { stage: 'MAP_INVENTORY', message: 'inventariando arquivos relevantes sem ler segredos' });
    inventory = buildInventory(projectRoot);
  } catch (error) {
    if (error instanceof MapPreflightError) return blocked(ctx, error.message, error.paths);
    throw error;
  }
  const currentTreeHash = sourceTreeHash(inventory);
  const previous = readMapState(paths);
  const staleMarker = readStaleMarker(paths);
  const drift = previous && metadata.is_repo ? gitDrift(projectRoot, previous.mapped_commit) : null;
  const baseUnavailable = Boolean(previous && metadata.is_repo && drift && !drift.accessible);
  const requestedPaths = [...new Set([...scopes, ...(staleMarker?.changed_paths ?? [])])].sort();
  const sameSourceTree = previous?.mapped_tree_hash === currentTreeHash;
  if (!options.full && !baseUnavailable && requestedPaths.length === 0 && previous?.status === 'COMPLETE' && sameSourceTree) {
    bus.emit('map.done', { status: 'completed', stage: 'MAP_DONE', message: 'mapa atual; validação concluída sem remapeamento' });
    return completed(ctx, 'Codebase map is fresh; no-op.');
  }

  const operation: CodebaseMapState['last_operation'] = options.full || !previous || baseUnavailable
    ? 'full'
    : scopes.length > 0
      ? 'paths'
      : 'incremental';
  const changedPaths =
    operation === 'full'
      ? []
      : [...new Set([...(drift?.changed ?? []), ...(staleMarker?.changed_paths ?? []), ...scopes])].sort();
  const effectiveScopes = operation === 'full' ? [] : changedPaths;

  bus.emit('map.history', { stage: 'MAP_HISTORY', message: 'calculando churn, renames, co-change e hotspots Git' });
  const history = collectGitHistory(projectRoot);
  const symbols = extractSymbols(projectRoot, inventory);
  const surfaces = extractSurfaces(projectRoot, inventory);
  const graph = buildDependencyGraph(inventory);
  const shards = partitionInventory(inventory, effectiveScopes);
  const deterministic = deterministicClaims(inventory, graph);
  const agentClaims: MapClaim[] = [];
  const gaps: string[] = [];

  if (ctx.executor.capabilities.subagents && shards.length > 0) {
    bus.emit('map.shards', {
      stage: 'MAP_SHARDS',
      message: `${shards.length} shard(s) com owner único, contexto fresco e supervisão`,
      totalUnits: shards.length,
    });
    const before = snapshotTree(projectRoot);
    const tasks: AgentTaskDraft[] = shards.map((shard) => ({
      id: shard.id,
      role: 'researcher',
      objective:
        'Map only the assigned shard. Return evidence-backed JSON about responsibilities, contracts, invariants, conventions, data flow, operations, and risks. Do not read files outside code_files, do not write any file, and do not infer a claim from a path name alone.',
      canonical_files: [],
      code_files: shard.files.map((file) => path.join(projectRoot, file.path)),
      write_scope: [],
      acceptance_criteria: [
        'Every claim has a real path and sha256 from the supplied shard inventory',
        'Every path belongs to exactly one assigned module',
        'No source or RIJO artifact is written',
      ],
      verification_commands: [],
      return_format:
        'AgentResult.payload JSON: {shard_id, module_ids[], claims[{kind: responsibility|contract|invariant|risk|convention|operation|data_flow, statement, evidence[{path,symbol?,lines?,file_hash}]}], gaps[]}',
      notes: `SHARD INVENTORY:\n${JSON.stringify(
        shard.files.map((file) => ({
          path: file.path,
          module_id: file.module_id,
          kind: file.kind,
          file_hash: file.file_hash,
          imports: file.imports,
          exports: file.exports,
        })),
      )}`,
    }));
    const attempts = tasks.map((task) =>
      replaceableAttempt(ctx, task, {}, {
        stage: 'RESEARCH',
        paths: task.code_files,
        requirementTags: ['codebase-discovery'],
      }),
    );
    let results;
    try {
      results = await dispatchBatch(
        ctx,
        attempts.map((attempt) => attempt.attempt.task),
        ctx.config.limits.max_parallel_agents,
        (task) => ({ stage: 'RESEARCH', paths: task.code_files, requirementTags: ['codebase-discovery'] }),
        (_task, index) => attempts[index]!.prepareReplacement,
      );
      for (const attempt of attempts) attempt.attempt.workspace.validate();
    } catch (error) {
      return blocked(ctx, 'A map agent violated its isolated read-only workspace.', [(error as Error).message]);
    } finally {
      for (const attempt of attempts) attempt.attempt.workspace.discard();
    }
    const violation = diffTrees(before, snapshotTree(projectRoot)).changed;
    if (violation.length > 0) {
      return blocked(ctx, 'A read-only map agent modified the controlled checkout.', violation);
    }
    for (let i = 0; i < results.length; i++) {
      const shard = shards[i]!;
      const result = results[i]!;
      if (!result.ok) {
        return blocked(ctx, `Supervised mapper ${shard.id} failed; the valid map was not replaced.`, [result.summary]);
      }
      const validation = validateFragmentDetailed(projectRoot, inventory, result.payload, shard.module_ids);
      if (!validation.fragment) {
        return blocked(ctx, `Mapper ${shard.id} returned invalid or unsupported evidence; the valid map was not replaced.`, [
          'Expected a Zod-valid fragment whose paths, hashes, lines, symbols, and module ownership match the assigned shard.',
          ...validation.errors.slice(0, 12),
        ]);
      }
      const fragment = validation.fragment;
      agentClaims.push(...fragment.claims);
      gaps.push(...fragment.gaps.map((gap) => `${shard.id}: ${gap}`));
    }
  } else {
    gaps.push('No agent runtime was bound; deterministic inventory, symbols, surfaces, dependencies, history, and claims were used.');
  }

  bus.emit('map.synthesis', { stage: 'MAP_SYNTHESIS', message: 'consolidando fragments sem duplicar ownership' });
  const previousClaims =
    operation === 'full'
      ? null
      : ClaimsDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'claims.json')));
  const retainedClaims =
    previousClaims?.success
      ? previousClaims.data.claims.filter((claim) => claimStillCurrent(claim, inventory, effectiveScopes))
      : [];
  const claims = dedupeClaims([...retainedClaims, ...deterministic, ...agentClaims]);
  const claimErrors = validateClaims(projectRoot, inventory, claims);
  if (claimErrors.length > 0) return blocked(ctx, 'Map synthesis contains invalid evidence.', claimErrors);

  bus.emit('map.review', { stage: 'MAP_REVIEW', message: 'revalidando paths, hashes, símbolos, contradições e cobertura' });
  if (ctx.executor.capabilities.subagents) {
    const reviewBefore = snapshotTree(projectRoot);
    const reviewTask: AgentTaskDraft = {
      id: 'map-review',
      role: 'reviewer',
      objective:
        'Independently review the candidate map claims for contradictions, invented paths or symbols, missing evidence, and material application-coverage gaps. Use only the supplied candidate, deterministic inventory/coverage summary, and read-only file inspection. Do not execute repository commands, tests, npm, git, network tools, or project processes, and do not write files. Static source evidence may establish an observed contract; never describe a detected test command as executed. Approve when claims are evidence-valid and the core coverage summary accounts for the application, even if tool-generated RIJO adapter documentation is not exhaustively paraphrased.',
      canonical_files: [],
      code_files: [],
      write_scope: [],
      acceptance_criteria: ['Findings use the declared review codes', 'Approval requires evidence-backed claims'],
      verification_commands: [],
      return_format:
        'AgentResult.payload JSON: {approved:boolean, findings:[{code:MISSING_EVIDENCE|BAD_PATH|BAD_HASH|BAD_SYMBOL|CONTRADICTION|COVERAGE_GAP,message,evidence:[{path,symbol?,lines?,file_hash}]}]}. Evidence must be structured objects copied from the candidate, never descriptive strings; use [] only when no specific file applies.',
      notes: `CORE INVENTORY COVERAGE (validated deterministically):\n${JSON.stringify(
        inventory.coverage,
      )}\nDOCUMENTED GAPS:\n${JSON.stringify(gaps)}\nCANDIDATE CLAIMS (core will independently validate regardless):\n${JSON.stringify(claims.slice(0, 250))}`,
    };
    const reviewAttempt = replaceableAttempt(ctx, reviewTask, {}, {
      stage: 'CODE_REVIEW',
      requirementTags: ['security'],
      highRisk: true,
      authorProfiles: ['discovery-analyst', 'system-architect'],
    });
    let result;
    try {
      result = await dispatch(
        ctx,
        reviewAttempt.attempt.task,
        {
          stage: 'CODE_REVIEW',
          requirementTags: ['security'],
          highRisk: true,
          authorProfiles: ['discovery-analyst', 'system-architect'],
        },
        { prepareReplacement: reviewAttempt.prepareReplacement },
      );
      reviewAttempt.attempt.workspace.validate();
    } catch (error) {
      return blocked(ctx, 'Map reviewer violated its isolated read-only workspace.', [(error as Error).message]);
    } finally {
      reviewAttempt.attempt.workspace.discard();
    }
    const violation = diffTrees(reviewBefore, snapshotTree(projectRoot)).changed;
    if (violation.length > 0) return blocked(ctx, 'Map reviewer modified the controlled checkout.', violation);
    const review = MapReviewSchema.safeParse(result.payload);
    if (!result.ok || !review.success) {
      return blocked(ctx, 'Independent map review did not produce a valid verdict; the valid map was not replaced.', [
        result.summary,
      ]);
    }
    if (!review.data.approved) {
      return blocked(ctx, 'Independent map review rejected the candidate.', review.data.findings.map((finding) => finding.message));
    }
  }

  bus.emit('map.baseline', { stage: 'MAP_BASELINE', message: 'executando baseline detectado em workspace isolado' });
  let baseline: BaselineDocument;
  const mustRefreshBaseline =
    operation === 'full' ||
    changedPaths.some((changed) => inventory.manifests.includes(changed) || inventory.lockfiles.includes(changed));
  if (!mustRefreshBaseline) {
    const parsed = BaselineDocumentSchema.safeParse(readJsonIfExists<unknown>(path.join(paths.codebaseDir, 'baseline.json')));
    baseline = parsed.success ? parsed.data : runBaseline(ctx, inventory, metadata.head, currentTreeHash, true);
  } else {
    baseline = runBaseline(ctx, inventory, metadata.head, currentTreeHash, true);
  }

  const staleReasons = [
    ...(baseUnavailable ? ['mapped commit is no longer accessible; full remap performed'] : []),
    ...(staleMarker?.reasons ?? []),
  ];
  const candidate = buildMapArtifacts({
    inventory,
    symbols,
    graph,
    surfaces,
    history,
    baseline,
    claims,
    gaps,
    commit: metadata.head,
    branch: metadata.branch,
    sourceTreeHash: currentTreeHash,
    mappedAt: now().toISOString(),
    changedPaths,
    staleReasons,
    operation,
  });
  validateCandidate(candidate.artifacts, candidate.state);

  bus.emit('map.commit', { stage: 'MAP_COMMIT', message: 'promovendo mapa validado por transação recuperável' });
  const transaction = MilestoneTransaction.begin(
    paths,
    { kind: 'codebase-map', prev: previous?.mapped_commit ?? null, next: metadata.head },
    options.nested ? {} : ctx.txnHooks,
    now,
  );
  transaction.stageDir(rel(projectRoot, paths.codebaseDir));
  for (const [name, body] of Object.entries(candidate.artifacts)) {
    transaction.stage(rel(projectRoot, path.join(paths.codebaseDir, name)), body);
  }
  if (!exists(path.join(paths.root, '.gitignore'))) {
    transaction.stage(rel(projectRoot, path.join(paths.root, '.gitignore')), authorizedRijoIgnore());
  }
  transaction.commitPoint();
  transaction.apply();
  transaction.finish();
  clearStaleMarker(paths);

  if (options.commit !== false && ctx.config.git.commit && metadata.is_repo) {
    const commitPaths = [rel(projectRoot, paths.codebaseDir)];
    if (exists(path.join(paths.root, '.gitignore'))) commitPaths.push(rel(projectRoot, path.join(paths.root, '.gitignore')));
    const mapCommit = ctx.git.commitPaths(projectRoot, `rijo(map): ${operation} codebase map`, commitPaths);
    if (!mapCommit) {
      return blocked(ctx, 'Codebase map was promoted but its configured Git commit failed.', commitPaths);
    }
  }

  bus.emit('map.done', {
    status: 'completed',
    stage: 'MAP_DONE',
    message: `mapa ${operation} completo: ${inventory.files.length} arquivos, ${graph.modules.length} módulos`,
  });
  return completed(ctx, `Codebase map ${operation} complete (${inventory.files.length} files, ${graph.modules.length} modules).`);
}

function dedupeClaims(claims: MapClaim[]): MapClaim[] {
  const map = new Map<string, MapClaim>();
  for (const claim of claims) {
    const key = `${claim.kind}\0${claim.statement}\0${claim.evidence.map((e) => `${e.path}:${e.file_hash}`).join('|')}`;
    if (!map.has(key)) map.set(key, claim);
  }
  return [...map.values()];
}

function validateCandidate(artifacts: Record<string, string>, state: CodebaseMapState): void {
  MapStateSchema.parse(state);
  for (const [name, expected] of Object.entries(state.artifact_hashes)) {
    const body = artifacts[name];
    if (body === undefined || sha256(body) !== expected) throw new Error(`Candidate artifact hash mismatch: ${name}`);
  }
  for (const name of ['inventory.json', 'symbols.json', 'dependency-graph.json', 'surfaces.json', 'claims.json', 'baseline.json', 'map-state.json']) {
    if (!artifacts[name]) throw new Error(`Candidate artifact missing: ${name}`);
    JSON.parse(artifacts[name]);
  }
}

function claimStillCurrent(
  claim: MapClaim,
  inventory: ReturnType<typeof buildInventory>,
  affectedPaths: string[],
): boolean {
  const byPath = new Map(inventory.files.map((file) => [file.path, file.file_hash]));
  return claim.evidence.every(
    (evidence) =>
      !affectedPaths.some(
        (affected) => evidence.path === affected || evidence.path.startsWith(`${affected.replace(/\/$/, '')}/`),
      ) && byPath.get(evidence.path) === evidence.file_hash,
  );
}

export function readCodebaseMapStatus(projectRoot: string): (CodebaseMapState & {
  freshness: 'FRESH' | 'STALE' | 'MISSING_BASE';
  live_changed_paths: string[];
}) | null {
  const metadata = resolveRepositoryMetadata(projectRoot);
  const paths = new RijoPaths(metadata.root);
  const state = readMapState(paths);
  if (!state) return null;
  const marker = readStaleMarker(paths);
  const drift = metadata.is_repo ? gitDrift(metadata.root, state.mapped_commit) : null;
  const workingChanges = metadata.is_repo ? dirtyApplicationPaths(metadata.root) : [];
  const changed = [...new Set([...(drift?.changed ?? []), ...workingChanges, ...(marker?.changed_paths ?? [])])].sort();
  const freshness = drift && !drift.accessible ? 'MISSING_BASE' : changed.length > 0 ? 'STALE' : 'FRESH';
  return { ...state, freshness, live_changed_paths: changed };
}

function recursiveMatches(value: unknown, term: string, source: string, key = 'root'): CodebaseQueryMatch[] {
  const matches: CodebaseQueryMatch[] = [];
  if (value === null || value === undefined) return matches;
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  if (text.toLowerCase().includes(term)) {
    matches.push({ source, key, path: null, snippet: text.slice(0, 300) });
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      const nested = recursiveMatches(item, term, source, `${key}[${index}]`);
      const itemPath =
        item && typeof item === 'object'
          ? ((item as Record<string, unknown>)['path'] as string | undefined) ??
            (((item as Record<string, unknown>)['evidence'] as Record<string, unknown> | undefined)?.['path'] as string | undefined)
          : undefined;
      for (const match of nested) matches.push({ ...match, path: match.path ?? itemPath ?? null });
    }
  } else if (typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (childKey.toLowerCase().includes(term)) {
        const ownPath = (value as Record<string, unknown>)['path'];
        matches.push({
          source,
          key: `${key}.${childKey}`,
          path: typeof ownPath === 'string' ? ownPath : null,
          snippet: JSON.stringify(child).slice(0, 300),
        });
      }
      matches.push(...recursiveMatches(child, term, source, `${key}.${childKey}`));
    }
  }
  return matches;
}

export function queryCodebaseMap(projectRoot: string, rawTerm: string): CodebaseQueryResult {
  const term = rawTerm.trim().toLowerCase();
  if (!term) return { term: rawTerm, matches: [], model_calls: 0 };
  const dir = new RijoPaths(resolveRepositoryMetadata(projectRoot).root).codebaseDir;
  const matches: CodebaseQueryMatch[] = [];
  for (const source of ['inventory.json', 'symbols.json', 'surfaces.json', 'dependency-graph.json', 'claims.json']) {
    const value = readJsonIfExists<unknown>(path.join(dir, source));
    if (value !== null) matches.push(...recursiveMatches(value, term, source));
  }
  const deduped = new Map(matches.map((match) => [`${match.source}:${match.key}:${match.path}:${match.snippet}`, match]));
  return { term: rawTerm, matches: [...deduped.values()].slice(0, 100), model_calls: 0 };
}
