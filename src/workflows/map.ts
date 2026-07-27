import * as fs from 'node:fs';
import * as path from 'node:path';
import { RijoPaths } from '../core/paths.js';
import { ensureDir, exists, readJsonIfExists, sha256, writeJsonAtomic } from '../core/fsx.js';
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
  dispatchReadOnly,
  commitDecisionProposals,
  discardDecisionProposals,
  commitPortableDurableArtifacts,
  replaceableAttempt,
  guardSchema,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
  type ValidatedAgentEnvelope,
} from './shared.js';
import { buildInventory, MapPreflightError } from '../codebase/inventory.js';
import {
  buildDependencyGraph,
  assessMapCoverage,
  deterministicClaims,
  expandImpactPaths,
  extractSurfaces,
  extractSymbols,
  partitionInventory,
  validateClaims,
  validateFragmentDetailed,
  validateUniqueAnalysisOwnership,
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
  type ClaimReceipt,
  type BaselineDocument,
  type CodebaseMapState,
  type InventoryDocument,
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
  const outcome = await mapCore(ctx, { ...options, nested: true, commit: options.commit ?? false });
  return { outcome, state: readMapState(ctx.paths) };
}

export async function mapCore(ctx: WorkflowContext, options: MapCoreOptions = {}): Promise<WorkflowOutcome> {
  const { projectRoot, paths, bus, now } = ctx;
  const schemaGuard = guardSchema(ctx);
  if (schemaGuard) return schemaGuard;

  // Durable initialization materializes canonical, commit-able migrations and
  // ignore policy before the map preflight. Seal those RIJO-owned files first
  // so they cannot be mistaken for an external application edit.
  commitPortableDurableArtifacts(ctx, 'map bootstrap');

  bus.emit('map.preflight', {
    status: 'running',
    stage: 'MAP_PREFLIGHT',
    message: 'Validate the root, checkout, symbolic links, and freshness.',
  });
  const metadata = resolveRepositoryMetadata(projectRoot);
  const requestedRoot = fs.realpathSync(projectRoot);
  if (!sameFilesystemPath(metadata.root, requestedRoot)) {
    return blocked(ctx, 'Map must run from the real repository root.', [
      `Resolved root: ${metadata.root}`,
      `Requested root: ${requestedRoot}`,
    ]);
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
    bus.emit('map.inventory', { stage: 'MAP_INVENTORY', message: 'Inventory relevant files without reading secrets.' });
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
  if (
    !options.full &&
    !baseUnavailable &&
    requestedPaths.length === 0 &&
    (previous?.status === 'COMPLETE' || previous?.status === 'PARTIAL') &&
    sameSourceTree
  ) {
    bus.emit('map.done', { status: 'completed', stage: 'MAP_DONE', message: 'The map is current. Validation did not require remapping.' });
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
  const impactScopes = operation === 'full' ? [] : expandImpactPaths(inventory, graph, surfaces, effectiveScopes);
  const shards = partitionInventory(inventory, impactScopes);
  const deterministic = deterministicClaims(inventory, graph).map((claim) =>
    withClaimIdentity(claim, 'deterministic'),
  );
  const agentClaims: MapClaim[] = [];
  const gaps: string[] = [];
  const mapperObservations: Array<{
    shard_id: string;
    code: 'MAPPER_REPORTED' | 'MAPPER_INSUFFICIENT';
    message: string;
    affected_paths: string[];
    affected_modules: string[];
  }> = [];
  const mapDecisionEnvelopes: ValidatedAgentEnvelope[] = [];
  const fragmentReceipts: Array<{
    shard_id: string;
    allowed_paths: string[];
    neighbor_contract_paths: string[];
    accepted_evidence: Array<{ path: string; ownership: 'primary' | 'external_contract' }>;
    rejected_evidence: Array<{ path: string; reason: string }>;
    semantic_coverage: import('../codebase/schemas.js').SemanticCoverageRecord[];
  }> = [];

  if (ctx.executor.capabilities.subagents && shards.length > 0) {
    bus.emit('map.shards', {
      stage: 'MAP_SHARDS',
      message: `${shards.length} shard(s) have one owner, current context, and supervision.`,
      totalUnits: shards.length,
    });
    const before = snapshotTree(projectRoot);
    const tasks: AgentTaskDraft[] = shards.map((shard) => {
      const primaryPaths = new Set(shard.files.map((file) => file.path));
      const neighborPaths = explicitNeighborContractPaths(shard.module_ids, graph, inventory, primaryPaths);
      return {
        id: shard.id,
      role: 'researcher',
      tier: 'balanced-reasoning',
      objective:
        'Map only the assigned shard. Return evidence-backed JSON about responsibilities, contracts, invariants, conventions, data flow, operations, and risks. Do not read files outside code_files, do not write any file, and do not infer a claim from a path name alone. Every inventoried path named in a claim statement must appear in that claim evidence. Avoid subjective labels such as standard, minimal, simple, clean, conventional, or fragile unless exact file evidence proves the label. For a shard containing only documentation or assets, zero claims and zero gaps is valid; absence of source code is not a coverage gap.',
      canonical_files: [],
      code_files: shard.files.map((file) => path.join(projectRoot, file.path)),
      write_scope: [],
      acceptance_criteria: [
        'Every claim has a real path and sha256 from the supplied shard inventory',
        'Primary evidence belongs to the exact code_files set, not merely another segment of the same module',
        'A supplied neighbor contract is marked ownership=external_contract and is never claimed as owned',
        'A behavioral shard returns a real semantic claim or an explicit factual gap',
        'No source or RIJO artifact is written',
      ],
      verification_commands: [],
      return_format:
        'AgentResult.payload JSON: {shard_id, module_ids[], claims[{kind: responsibility|entrypoint|contract|invariant|dependency|consumer|data_flow|convention|test|operation|risk|placement, statement, evidence[{path,symbol?,lines?,file_hash,ownership:primary|external_contract}]}], semantic_coverage:[{module_id,category:responsibility|entrypoints|contracts|invariants|dependencies|consumers|data_flow|conventions|tests|operations|risks|placement,status:COVERED|GAP|NOT_APPLICABLE,rationale}], gaps:[{code:RESPONSIBILITY_UNKNOWN|ENTRYPOINT_UNKNOWN|CONTRACT_UNKNOWN|INVARIANT_UNKNOWN|DEPENDENCY_UNKNOWN|CONSUMER_UNKNOWN|DATA_FLOW_UNKNOWN|CONVENTION_UNKNOWN|TEST_COVERAGE_UNKNOWN|OPERATION_UNKNOWN|RISK_UNKNOWN|PLACEMENT_UNKNOWN,message,affected_paths[]}]} . Every behavioral module must disposition every semantic category exactly once. COVERED needs a matching primary claim of the corresponding kind, GAP needs the matching factual gap, and NOT_APPLICABLE is forbidden when the supplied matrix says applicable=true.',
      notes: [
        `SHARD INVENTORY:\n${JSON.stringify(
          shard.files.map((file) => ({
            path: file.path,
            module_id: file.module_id,
            kind: file.kind,
            file_hash: file.file_hash,
            imports: file.imports,
            exports: file.exports,
          })),
        )}`,
        `REQUIRED SEMANTIC COVERAGE MATRIX:\n${JSON.stringify(
          semanticCoverageRequirements(shard.files),
        )}`,
        `EVIDENCE OWNERSHIP MATRIX:\n${JSON.stringify([
          ...[...primaryPaths].sort().map((evidencePath) => ({ path: evidencePath, ownership: 'primary' })),
          ...[...neighborPaths].sort().map((evidencePath) => ({
            path: evidencePath,
            ownership: 'external_contract',
          })),
        ])}`,
        'Every evidence object must use the ownership value assigned to its exact path above. Never infer external_contract from an import relationship. A claim statement must never name a literal path absent from this matrix.',
        'Return exactly one semantic_coverage record for every module_id/category pair in that matrix. Use COVERED with a matching primary claim, GAP with the matching factual gap, or NOT_APPLICABLE only where applicable=false.',
        'For .gitignore evidence, never claim that a pattern excludes already tracked files: it only affects untracked/new matching paths by default unless a file is explicitly untracked.',
      ].join('\n\n'),
      };
    });
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
      for (let index = 0; index < attempts.length; index++) {
        // An exhausted/failed replacement has already discarded its workspace.
        // Inspect that result in the normal failure gate below; only a
        // successful generation owns a live workspace that can be validated.
        if (results[index]?.ok) attempts[index]!.attempt.workspace.validate();
      }
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
      const allowedPaths = new Set(shard.files.map((file) => file.path));
      const neighborContractPaths = explicitNeighborContractPaths(shard.module_ids, graph, inventory, allowedPaths);
      let result = results[i]!;
      if (!result.ok) {
        return blocked(ctx, `Supervised mapper ${shard.id} failed; the valid map was not replaced.`, [result.summary]);
      }
      let validation = validateFragmentDetailed(
        projectRoot,
        inventory,
        result.payload,
        allowedPaths,
        neighborContractPaths,
      );
      if (!validation.fragment) {
        discardDecisionProposals(ctx, result);
        const correctionBefore = snapshotTree(projectRoot);
        const correction = replaceableAttempt(
          ctx,
          {
            ...tasks[i]!,
            id: `${shard.id}-correction`,
            objective: `${tasks[i]!.objective} Correct the previous structured payload using the exact schema errors below; do not repeat or omit them. Revalidate the entire output contract, not only the listed field. If a claim cites a path outside the supplied ownership matrix, delete or rewrite that claim; never import evidence from another shard.`,
            notes: [
              `REQUIRED LOGICAL SHARD OWNER: return shard_id exactly "${shard.id}".`,
              `The dispatch attempt id "${shard.id}-correction" is not a shard owner and must never appear as payload.shard_id.`,
              `PREVIOUS PAYLOAD ERRORS:\n${validation.errors.join('\n')}`,
              tasks[i]!.notes ?? '',
            ].join('\n\n'),
          },
          {},
          {
            stage: 'RESEARCH',
            paths: shard.files.map((file) => path.join(projectRoot, file.path)),
            requirementTags: ['codebase-discovery'],
          },
        );
        try {
          result = await dispatch(
            ctx,
            correction.attempt.task,
            {
              stage: 'RESEARCH',
              paths: correction.attempt.task.code_files,
              requirementTags: ['codebase-discovery'],
            },
            { prepareReplacement: correction.prepareReplacement },
          );
          correction.attempt.workspace.validate();
        } catch (error) {
          return blocked(ctx, `Mapper ${shard.id} correction violated its isolated workspace.`, [
            (error as Error).message,
          ]);
        } finally {
          correction.attempt.workspace.discard();
        }
        const correctionViolation = diffTrees(correctionBefore, snapshotTree(projectRoot)).changed;
        if (correctionViolation.length > 0) {
          return blocked(ctx, `Mapper ${shard.id} correction modified the controlled checkout.`, correctionViolation);
        }
        validation = validateFragmentDetailed(
          projectRoot,
          inventory,
          result.payload,
          allowedPaths,
          neighborContractPaths,
        );
      }
      if (!validation.fragment) {
        const essentialBehavior = shard.files.some((file) =>
          ['code', 'test', 'migration', 'script'].includes(file.kind),
        );
        if (essentialBehavior) {
          return blocked(ctx, `Mapper ${shard.id} returned invalid or unsupported evidence; the valid map was not replaced.`, [
            'Expected a Zod-valid fragment whose paths, hashes, lines, symbols, and module ownership match the assigned shard.',
            ...validation.errors.slice(0, 12),
          ]);
        }
        fragmentReceipts.push(validation.receipt);
        mapperObservations.push({
          shard_id: shard.id,
          code: 'MAPPER_INSUFFICIENT',
          message: `MAPPER_INSUFFICIENT: ${validation.errors.join('; ')}`,
          affected_paths: shard.files.map((file) => file.path),
          affected_modules: shard.module_ids,
        });
        discardDecisionProposals(ctx, result);
        bus.emit('map.shard_partial', {
          stage: 'MAP_SYNTHESIS',
          message: `${shard.id}: insufficient non-code analysis recorded as a structured PARTIAL gap`,
        });
        continue;
      }
      const fragment = validation.fragment;
      if (fragment.shard_id !== shard.id) {
        return blocked(ctx, `Mapper ${shard.id} returned a fragment for another shard; the valid map was not replaced.`, [
          `Expected shard_id=${shard.id}; received ${fragment.shard_id}.`,
        ]);
      }
      fragmentReceipts.push(validation.receipt);
      const ownershipErrors = validateUniqueAnalysisOwnership(fragmentReceipts);
      if (ownershipErrors.length > 0) {
        return blocked(ctx, 'Map synthesis found conflicting exact-path analysis ownership.', ownershipErrors);
      }
      mapDecisionEnvelopes.push(result);
      agentClaims.push(...fragment.claims.map((claim) => withClaimIdentity(claim, shard.id)));
      mapperObservations.push(
        ...fragment.gaps.map((gap) => ({
          shard_id: shard.id,
          code: 'MAPPER_REPORTED' as const,
          message: `${gap.code}: ${gap.message} (${gap.affected_paths.join(', ')})`,
          affected_paths: gap.affected_paths,
          affected_modules: fragment.module_ids,
        })),
      );
      const requiresCodeSemanticCoverage = shard.files.some(
        (file) => file.kind !== 'documentation' && file.kind !== 'asset',
      );
      if (!requiresCodeSemanticCoverage && fragment.gaps.length > 0) {
        bus.emit('map.non_blocking_documentation_gap', {
          stage: 'MAP_SYNTHESIS',
          message: `${shard.id}: recorded ${fragment.gaps.length} non-code mapper observation(s)`,
        });
      }
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
      ? previousClaims.data.claims.filter((claim) => claimStillCurrent(claim, inventory, impactScopes))
      : [];
  let claims = dedupeClaims([
    ...retainedClaims.map((claim) => withClaimIdentity(claim, claim.source_shard ?? 'retained')),
    ...deterministic,
    ...agentClaims,
  ]);
  const claimErrors = validateClaims(projectRoot, inventory, claims);
  if (claimErrors.length > 0) return blocked(ctx, 'Map synthesis contains invalid evidence.', claimErrors);
  const provisionalAssessment = assessMapCoverage(inventory, symbols, surfaces, graph, claims, {
    baselineStatus: 'NOT_AVAILABLE',
    gaps,
  });
  inventory.coverage = provisionalAssessment.coverage;

  bus.emit('map.review', { stage: 'MAP_REVIEW', message: 'Revalidate paths, hashes, symbols, contradictions, and coverage.' });
  const claimReceipts: ClaimReceipt[] = [];
  let consolidationStatus: 'APPROVED' | 'NOT_REVIEWED' = 'NOT_REVIEWED';
  const contradictions = detectClaimContradictions(claims);
  if (contradictions.length > 0) {
    return blocked(ctx, 'Map synthesis contains contradictory cross-module claims.', contradictions);
  }
  if (ctx.executor.capabilities.subagents) {
    const reviewContext = [
      ...gaps,
      ...mapperObservations.map((observation) => `${observation.shard_id}: ${observation.message}`),
    ];
    let review = await reviewClaimSet(ctx, inventory, claims, reviewContext, 'map-review');
    if (review.status === 'INVALID') {
      persistRejectedClaimReceipts(ctx, claims, review);
      return blocked(ctx, 'Independent map review did not produce a valid verdict; the valid map was not replaced.', review.details);
    }
    if (review.status === 'REJECTED') {
      persistRejectedClaimReceipts(ctx, claims, review);
      return blocked(ctx, 'Independent map review rejected candidate claims; the valid map was not replaced.', [
        ...review.details,
      ]);
    }
    claimReceipts.push(...review.receipts);
    if (review.status === 'PARTIAL') {
      gaps.push(...review.details.map((detail) => `Independent review rejected a non-critical claim: ${detail}`));
      const approvedClaimIds = new Set(
        review.receipts
          .filter((receipt) => receipt.final_disposition === 'APPROVED')
          .map((receipt) => receipt.claim_id),
      );
      claims = claims.filter((claim) => approvedClaimIds.has(claim.claim_id!));
    } else {
      mapDecisionEnvelopes.push(...(review.envelopes ?? []));
    }
    consolidationStatus = review.consolidation;
  } else {
    for (const claim of claims) {
      claimReceipts.push({
        claim_id: claim.claim_id!,
        source_shard: claim.source_shard!,
        structural_status: 'PASSED',
        semantic_status: 'NOT_REVIEWED',
        reviewer_attempt: null,
        reviewed_at: now().toISOString(),
        evidence_hash: claimEvidenceHash(claim),
        final_disposition: 'PARTIAL',
      });
    }
  }

  bus.emit('map.baseline', { stage: 'MAP_BASELINE', message: 'Run the detected baseline in an isolated workspace.' });
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
  const assessment = assessMapCoverage(inventory, symbols, surfaces, graph, claims, {
    baselineStatus: baseline.overall_status,
    gaps: [
      ...gaps,
      ...mapperObservations.map((observation) => `${observation.shard_id}: ${observation.message}`),
    ],
    gapRecords: mapperObservations.map((observation) => ({
      code: observation.code,
      category: 'semantic' as const,
      severity: 'non_critical' as const,
      message: `${observation.shard_id}: ${observation.message}`,
      affected_paths: observation.affected_paths,
      affected_modules: observation.affected_modules,
    })),
    claimReceipts,
    runtimeAvailable: ctx.executor.capabilities.subagents,
    baselineWaiverSafe: baseline.overall_status === 'WAIVED' && baseline.waiver?.safe === true,
  });
  inventory.coverage = assessment.coverage;
  if (assessment.status === 'BLOCKED') {
    return blockedReadOnly(ctx, `Codebase map ${operation} is BLOCKED; the valid previous map was preserved.`, [
      ...assessment.gaps,
    ]);
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
    gaps: assessment.gaps,
    gapRecords: assessment.gapRecords,
    observations: mapperObservations,
    commit: metadata.head,
    branch: metadata.branch,
    sourceTreeHash: currentTreeHash,
    mappedAt: now().toISOString(),
    changedPaths,
    staleReasons,
    operation,
    status: assessment.status,
    reviewReceipts: {
      claim_receipts: claimReceipts,
      shard_receipts: fragmentReceipts,
      mapper_observations: mapperObservations.map((observation) => ({
        ...observation,
        review_status: 'APPROVED_NON_BLOCKING' as const,
      })),
      consolidation: { status: consolidationStatus, contradictions },
    },
  });
  validateCandidate(candidate.artifacts, candidate.state);

  bus.emit('map.commit', { stage: 'MAP_COMMIT', message: 'Promote the validated map with a recoverable transaction.' });
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
  for (const envelope of mapDecisionEnvelopes) commitDecisionProposals(ctx, envelope);
  if (
    options.commit !== false &&
    ctx.config.git.commit &&
    metadata.is_repo &&
    ctx.config.decisions.record_material_decisions &&
    mapDecisionEnvelopes.some((envelope) =>
      envelope.pending_decisions.some((decision) => decision.proposal.material),
    )
  ) {
    const decisionPaths = [paths.decisions, paths.manifest]
      .filter((target) => exists(target))
      .map((target) => rel(projectRoot, target));
    const dirtyDecisionPaths = ctx.git
      .status(projectRoot)
      .dirtyFiles.filter((dirty) => decisionPaths.includes(dirty));
    if (
      dirtyDecisionPaths.length > 0 &&
      !ctx.git.commitPaths(projectRoot, `rijo(map): persist approved decisions`, dirtyDecisionPaths)
    ) {
      return blocked(
        ctx,
        'Codebase map decisions were approved and persisted, but their configured Git commit failed.',
        dirtyDecisionPaths,
      );
    }
  }

  bus.emit('map.done', {
    status: candidate.state.status === 'BLOCKED' ? 'blocked' : 'completed',
    stage: 'MAP_DONE',
    message: `${operation} map ${candidate.state.status.toLowerCase()}: ${inventory.files.length} files, ${graph.modules.length} modules.`,
  });
  return completed(
    ctx,
    `Codebase map ${operation} ${candidate.state.status.toLowerCase()} (${inventory.files.length} files, ${graph.modules.length} modules).`,
  );
}

type ClaimReviewReceipt = ClaimReceipt;

type ClaimReviewOutcome =
  | {
      status: 'APPROVED';
      details: string[];
      receipts: ClaimReviewReceipt[];
      consolidation: 'APPROVED';
      envelopes: ValidatedAgentEnvelope[];
    }
  | {
      status: 'PARTIAL' | 'REJECTED' | 'INVALID';
      details: string[];
      receipts: ClaimReviewReceipt[];
      consolidation: 'NOT_REVIEWED';
      envelopes?: never;
    };

async function reviewClaimSet(
  ctx: WorkflowContext,
  inventory: InventoryDocument,
  claims: MapClaim[],
  gaps: string[],
  idPrefix: string,
): Promise<ClaimReviewOutcome> {
  const before = snapshotTree(ctx.projectRoot);
  const claimShards: MapClaim[][] = [];
  for (let index = 0; index < claims.length; index += 100) claimShards.push(claims.slice(index, index + 100));
  const reviewTasks: AgentTaskDraft[] = claimShards.map((claimShard, index) => ({
    id: `${idPrefix}-${String(index + 1).padStart(3, '0')}`,
    role: 'reviewer',
    objective:
      'Independently review every claim in this bounded shard for contradictions, invented paths or symbols, missing evidence, semantic overreach, and material application-coverage gaps. Mapper observations are non-blocking unless they make an accurate map unsafe; absence of a consumer, optional convention, or inferred purpose is not itself a coverage gap. Use only the supplied claim shard, deterministic inventory/coverage summary, and read-only file inspection. Do not execute repository commands, tests, npm, git, network tools, or project processes, and do not write files. Static source evidence may establish an observed contract; never describe a detected test command as executed.',
    canonical_files: [],
    code_files: [
      ...new Set(claimShard.flatMap((claim) => claim.evidence.map((item) => path.join(ctx.projectRoot, item.path)))),
    ],
    write_scope: [],
    acceptance_criteria: ['Every supplied claim receives semantic review', 'Findings use the declared review codes'],
    verification_commands: [],
    return_format:
      'AgentResult.payload JSON: {approved:boolean, findings:[{code:MISSING_EVIDENCE|BAD_PATH|BAD_HASH|BAD_SYMBOL|CONTRADICTION|COVERAGE_GAP,message,evidence:[{path,symbol?,lines?,file_hash}]}]}. Evidence must be structured objects copied from the candidate, never descriptive strings; use [] only when no specific file applies.',
    notes: `CORE INVENTORY COVERAGE:\n${JSON.stringify(inventory.coverage)}\nDOCUMENTED GAPS AND MAPPER OBSERVATIONS:\n${JSON.stringify(
      gaps,
    )}\nCANDIDATE CLAIM SHARD:\n${JSON.stringify(claimShard)}`,
  }));
  let results;
  try {
    results = await dispatchBatch(
      ctx,
      reviewTasks,
      ctx.config.limits.max_parallel_agents,
      () => ({
        stage: 'CODE_REVIEW',
        requirementTags: ['security'],
        highRisk: true,
        authorProfiles: ['discovery-analyst', 'system-architect'],
      }),
    );
  } catch (error) {
    return {
      status: 'INVALID',
      details: [`Map reviewer violated its isolated read-only workspace: ${(error as Error).message}`],
      receipts: [],
      consolidation: 'NOT_REVIEWED',
    };
  }
  const violation = diffTrees(before, snapshotTree(ctx.projectRoot)).changed;
  if (violation.length > 0) {
    return {
      status: 'INVALID',
      details: ['Map reviewer modified the controlled checkout.', ...violation],
      receipts: [],
      consolidation: 'NOT_REVIEWED',
    };
  }
  const receipts: ClaimReviewReceipt[] = [];
  const approvedEnvelopes: ValidatedAgentEnvelope[] = [];
  const rejected: string[] = [];
  let criticalRejection = false;
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const review = MapReviewSchema.safeParse(result.payload);
    if (!result.ok || !review.success) {
      discardDecisionProposals(ctx, result);
      return {
        status: 'INVALID',
        details: [result.summary],
        receipts: [],
        consolidation: 'NOT_REVIEWED',
      };
    }
    for (const finding of review.data.findings) {
      const evidenceErrors = validateClaims(ctx.projectRoot, inventory, [
        { kind: 'risk', statement: finding.message, evidence: finding.evidence },
      ]);
      if (evidenceErrors.length > 0) {
        return {
          status: 'INVALID',
          details: [`Reviewer finding contains invented evidence: ${evidenceErrors.join('; ')}`],
          receipts: [],
          consolidation: 'NOT_REVIEWED',
        };
      }
    }
    if (!review.data.approved || review.data.findings.length > 0) {
      discardDecisionProposals(ctx, result);
      const findingPaths = new Set(review.data.findings.flatMap((finding) => finding.evidence.map((item) => item.path)));
      const rejectWholeShard = findingPaths.size === 0;
      for (const claim of claimShards[index]!) {
        const rejectedClaim =
          rejectWholeShard || claim.evidence.some((evidence) => findingPaths.has(evidence.path));
        receipts.push({
          claim_id: claim.claim_id!,
          source_shard: claim.source_shard!,
          structural_status: 'PASSED',
          semantic_status: rejectedClaim ? 'REJECTED' : 'APPROVED',
          reviewer_attempt: reviewTasks[index]!.id,
          reviewed_at: ctx.now().toISOString(),
          evidence_hash: claimEvidenceHash(claim),
          final_disposition: rejectedClaim ? 'REJECTED' : 'APPROVED',
        });
      }
      criticalRejection ||= review.data.findings.some(
        (finding) =>
          finding.evidence.length === 0 ||
          ['BAD_PATH', 'BAD_HASH', 'BAD_SYMBOL', 'CONTRADICTION'].includes(finding.code),
      );
      rejected.push(
        ...(review.data.findings.length > 0
          ? review.data.findings.map((finding) => finding.message)
          : [result.summary]),
      );
      continue;
    }
    approvedEnvelopes.push(result);
    for (const claim of claimShards[index]!) {
      receipts.push({
        claim_id: claim.claim_id!,
        source_shard: claim.source_shard!,
        structural_status: 'PASSED',
        semantic_status: 'APPROVED',
        reviewer_attempt: reviewTasks[index]!.id,
        reviewed_at: ctx.now().toISOString(),
        evidence_hash: claimEvidenceHash(claim),
        final_disposition: 'APPROVED',
      });
    }
  }
  if (rejected.length > 0) {
    return {
      status: criticalRejection ? 'REJECTED' : 'PARTIAL',
      details: rejected,
      receipts,
      consolidation: 'NOT_REVIEWED',
    };
  }
  if (claimShards.length > 1) {
    const { result, violation: consolidationViolation } = await dispatchReadOnlyMapConsolidation(
      ctx,
      claimShards,
      receipts,
      `${idPrefix}-consolidation`,
    );
    if (consolidationViolation.length > 0) {
      return {
        status: 'INVALID',
        details: ['Map consolidation reviewer modified the controlled checkout.', ...consolidationViolation],
        receipts: [],
        consolidation: 'NOT_REVIEWED',
      };
    }
    const review = MapReviewSchema.safeParse(result.payload);
    if (!result.ok || !review.success) {
      discardDecisionProposals(ctx, result);
      return {
        status: 'INVALID',
        details: [result.summary],
        receipts: [],
        consolidation: 'NOT_REVIEWED',
      };
    }
    if (!review.data.approved || review.data.findings.length > 0) {
      discardDecisionProposals(ctx, result);
      return {
        status: 'REJECTED',
        details: review.data.findings.map((finding) => finding.message),
        receipts: receipts.map((receipt) => ({
          ...receipt,
          semantic_status: 'REJECTED' as const,
          final_disposition: 'REJECTED' as const,
          reviewer_attempt: `${idPrefix}-consolidation`,
          reviewed_at: ctx.now().toISOString(),
        })),
        consolidation: 'NOT_REVIEWED',
      };
    }
    approvedEnvelopes.push(result);
  }
  return {
    status: 'APPROVED',
    details: [],
    receipts,
    consolidation: 'APPROVED',
    envelopes: approvedEnvelopes,
  };
}

function persistRejectedClaimReceipts(
  ctx: WorkflowContext,
  claims: MapClaim[],
  review: Exclude<ClaimReviewOutcome, { status: 'APPROVED' }>,
): void {
  const byId = new Map(review.receipts.map((receipt) => [receipt.claim_id, receipt]));
  const receipts = claims.map(
    (claim): ClaimReceipt =>
      byId.get(claim.claim_id!) ?? {
        claim_id: claim.claim_id!,
        source_shard: claim.source_shard!,
        structural_status: 'PASSED',
        semantic_status: 'NOT_REVIEWED',
        reviewer_attempt: null,
        reviewed_at: ctx.now().toISOString(),
        evidence_hash: claimEvidenceHash(claim),
        final_disposition: 'PARTIAL',
      },
  );
  const dir = path.join(ctx.paths.runtimeDir, 'map-review-rejections');
  ensureDir(dir);
  const candidateHash = sha256(
    JSON.stringify(receipts.map((receipt) => [receipt.claim_id, receipt.evidence_hash, receipt.final_disposition])),
  );
  writeJsonAtomic(path.join(dir, `${candidateHash}.json`), {
    schema_version: 1,
    status: review.status,
    reviewed_at: ctx.now().toISOString(),
    details: review.details,
    receipts,
  });
}

async function dispatchReadOnlyMapConsolidation(
  ctx: WorkflowContext,
  claimShards: MapClaim[][],
  receipts: ClaimReceipt[],
  taskId = 'map-review-consolidation',
): Promise<{ result: ValidatedAgentEnvelope; violation: string[] }> {
  const summaries = claimShards.map((shard, index) => ({
    shard: `map-review-${String(index + 1).padStart(3, '0')}`,
    claims: shard.map((claim) => ({
      kind: claim.kind,
      statement: claim.statement,
      evidence_paths: claim.evidence.map((item) => item.path),
      claim_id: claim.claim_id,
      evidence_hash: claimEvidenceHash(claim),
    })),
  }));
  return dispatchReadOnly(
    ctx,
    {
      id: taskId,
      role: 'reviewer',
      objective:
        'Consolidate the independently reviewed claim shards. Detect semantic contradictions between modules and cross-cutting documents. Do not repeat per-file validation, execute commands, or write files.',
      canonical_files: [],
      code_files: [],
      write_scope: [],
      acceptance_criteria: [
        'Every shard has structural and semantic receipts',
        'Cross-shard contradictions are reported with the declared review codes',
      ],
      verification_commands: [],
      return_format:
        'AgentResult.payload JSON: {approved:boolean, findings:[{code:MISSING_EVIDENCE|BAD_PATH|BAD_HASH|BAD_SYMBOL|CONTRADICTION|COVERAGE_GAP,message,evidence:[]}]}',
      notes: `REVIEWED SHARD SUMMARIES:\n${JSON.stringify(summaries)}\nFINAL RECEIPTS:\n${JSON.stringify(receipts)}`,
    },
    {
      stage: 'CODE_REVIEW',
      requirementTags: ['security'],
      highRisk: true,
      authorProfiles: ['discovery-analyst', 'system-architect'],
    },
  );
}

function detectClaimContradictions(claims: MapClaim[]): string[] {
  const byEvidence = new Map<string, MapClaim[]>();
  for (const claim of claims) {
    const key = `${claim.kind}\0${claim.evidence.map((item) => item.path).sort().join('|')}`;
    const existing = byEvidence.get(key) ?? [];
    existing.push(claim);
    byEvidence.set(key, existing);
  }
  const contradictions: string[] = [];
  for (const group of byEvidence.values()) {
    for (let left = 0; left < group.length; left++) {
      for (let right = left + 1; right < group.length; right++) {
        const a = group[left]!.statement.toLowerCase();
        const b = group[right]!.statement.toLowerCase();
        const normalizedA = a.replace(/\b(?:not|never|no)\b/g, '').replace(/\s+/g, ' ').trim();
        const normalizedB = b.replace(/\b(?:not|never|no)\b/g, '').replace(/\s+/g, ' ').trim();
        const aNegated = normalizedA !== a.replace(/\s+/g, ' ').trim();
        const bNegated = normalizedB !== b.replace(/\s+/g, ' ').trim();
        if (normalizedA === normalizedB && aNegated !== bNegated) {
          contradictions.push(`Contradictory claims for ${group[left]!.evidence.map((item) => item.path).join(', ')}`);
        }
      }
    }
  }
  return contradictions;
}

function dedupeClaims(claims: MapClaim[]): MapClaim[] {
  const map = new Map<string, MapClaim>();
  for (const claim of claims) {
    const key = `${claim.kind}\0${claim.statement}\0${claim.evidence.map((e) => `${e.path}:${e.file_hash}`).join('|')}`;
    if (!map.has(key)) map.set(key, claim);
  }
  return [...map.values()];
}

function claimEvidenceHash(claim: MapClaim): string {
  return sha256(
    JSON.stringify(
      claim.evidence
        .map((evidence) => ({
          path: evidence.path,
          symbol: evidence.symbol ?? null,
          lines: evidence.lines ?? null,
          file_hash: evidence.file_hash,
          ownership: evidence.ownership,
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    ),
  );
}

function withClaimIdentity(claim: MapClaim, sourceShard: string): MapClaim {
  const source = claim.source_shard ?? sourceShard;
  return {
    ...claim,
    source_shard: source,
    claim_id:
      claim.claim_id ??
      `claim-${sha256(
        JSON.stringify({
          source,
          kind: claim.kind,
          statement: claim.statement,
          evidence_hash: claimEvidenceHash(claim),
        }),
      ).slice(0, 24)}`,
  };
}

function validateCandidate(artifacts: Record<string, string>, state: CodebaseMapState): void {
  MapStateSchema.parse(state);
  for (const [name, expected] of Object.entries(state.artifact_hashes)) {
    const body = artifacts[name];
    if (body === undefined || sha256(body) !== expected) throw new Error(`Candidate artifact hash mismatch: ${name}`);
  }
  for (const name of [
    'inventory.json',
    'symbols.json',
    'dependency-graph.json',
    'surfaces.json',
    'claims.json',
    'baseline.json',
    'review-receipts.json',
    'map-state.json',
  ]) {
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

function semanticCoverageRequirements(files: InventoryDocument['files']): Array<{
  module_id: string;
  category: string;
  applicable: boolean;
}> {
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
  const behavioralModules = [
    ...new Set(
      files
        .filter((file) => ['code', 'test', 'migration', 'script'].includes(file.kind))
        .map((file) => file.module_id),
    ),
  ].sort();
  return behavioralModules.flatMap((moduleId) => {
    const moduleFiles = files.filter((file) => file.module_id === moduleId);
    const applicable = new Set<string>(['responsibility', 'conventions', 'placement']);
    if (moduleFiles.some((file) => file.kind === 'code' && file.exports.length > 0)) {
      applicable.add('entrypoints');
      applicable.add('contracts');
    }
    if (moduleFiles.some((file) => file.kind === 'code' && file.imports.length > 0)) {
      applicable.add('dependencies');
    }
    if (moduleFiles.some((file) => file.kind === 'test')) applicable.add('tests');
    if (moduleFiles.some((file) => file.kind === 'script')) applicable.add('operations');
    if (moduleFiles.some((file) => file.kind === 'migration')) applicable.add('data_flow');
    return categories.map((category) => ({
      module_id: moduleId,
      category,
      applicable: applicable.has(category),
    }));
  });
}

function explicitNeighborContractPaths(
  moduleIds: string[],
  graph: ReturnType<typeof buildDependencyGraph>,
  inventory: InventoryDocument,
  allowedPaths: Set<string>,
): Set<string> {
  const neighbors = new Set(
    graph.modules
      .filter((module) => moduleIds.includes(module.id))
      .flatMap((module) => [...module.dependencies, ...module.consumers]),
  );
  return new Set(
    inventory.files
      .filter(
        (file) =>
          !allowedPaths.has(file.path) &&
          neighbors.has(file.module_id) &&
          file.exports.length > 0,
      )
      .map((file) => file.path),
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
