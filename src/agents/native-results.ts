import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import {
  appendLine,
  assertContainedWithoutSymlinks,
  exists,
  readJson,
  readText,
  sha256,
  sha256File,
  ensureDir,
  writeBufferAtomic,
  writeFileAtomic,
  writeJsonAtomic,
} from '../core/fsx.js';
import { pathInScope } from '../core/scope.js';
import {
  AgentTaskSchema,
  type AgentResult,
  type AgentTask,
} from './protocol.js';
import type { AgentRunner, ReplayAttemptIdentity, RunnerCapabilities } from './runner.js';
import {
  WorkflowEpochSchema,
  createWorkflowEpoch,
  type WorkflowEpoch,
} from '../core/workflow-epoch.js';

const NativeIdentitySchema = z.object({
  workflow_epoch: WorkflowEpochSchema,
  request_id: z.string().regex(/^nreq_[a-f0-9]{64}$/),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  logical_task_id: z.string().min(1),
  attempt_id: z.string().min(1),
  generation: z.number().int().min(1),
  lease_id: z.string().min(1),
  idempotency_key: z.string().min(1),
});

const NativeRelativePathSchema = z.string().min(1).superRefine((value, context) => {
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === '.' ||
    value.split('/').includes('..')
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Native result paths must be normalized project-relative POSIX paths.',
    });
  }
});

export const NativeArtifactReferenceSchema = z.object({
  target_path: NativeRelativePathSchema,
  staged_path: NativeRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0),
  media_type: z.string().min(1),
});
export type NativeArtifactReference = z.infer<typeof NativeArtifactReferenceSchema>;

export const NativePreservedFileSchema = z.object({
  target_path: NativeRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  workspace_id: z.string().min(1),
  baseline_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
export type NativePreservedFile = z.infer<typeof NativePreservedFileSchema>;

export const NativeDeletedPathSchema = z.object({
  path: NativeRelativePathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeDeletedPath = z.infer<typeof NativeDeletedPathSchema>;

export const NativeRenameSchema = z.object({
  source_path: NativeRelativePathSchema,
  target_path: NativeRelativePathSchema,
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).refine((operation) => operation.source_path !== operation.target_path, {
  message: 'A native rename source and target must be different.',
});
export type NativeRename = z.infer<typeof NativeRenameSchema>;

export const NativeRequestV2Schema = NativeIdentitySchema.extend({
  role: z.string().min(1),
  tier: z.string().optional(),
  objective: z.string().min(1),
  workspace_id: z.string().nullable(),
  canonical_files: z.array(z.string()),
  code_files: z.array(z.string()),
  write_scope: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  verification_commands: z.array(z.string()),
  return_format: z.string().min(1),
  notes: z.string(),
  expert_profiles: z.array(z.string()),
  result_contract: z.object({
    protocol: z.literal('NativeResultV2'),
    identity_fields: z.array(z.string()),
    payload: z.string(),
    files: z.string(),
    artifacts: z.string(),
    preserved_files: z.string(),
    deleted_paths: z.string(),
    renames: z.string(),
    decision_proposals: z.string(),
  }),
});
export type NativeRequestV2 = z.infer<typeof NativeRequestV2Schema>;

export const NativeResultV2Schema = NativeIdentitySchema.extend({
  ok: z.boolean(),
  summary: z.string().min(1),
  payload: z.unknown().nullable().default(null),
  files: z.record(NativeRelativePathSchema, z.string()).default({}),
  files_written: z.array(NativeRelativePathSchema).default([]),
  scope_requests: z.array(z.string()).default([]),
  decision_proposals: z.array(z.unknown()).default([]),
  artifacts: z.array(NativeArtifactReferenceSchema).default([]),
  preserved_files: z.array(NativePreservedFileSchema).default([]),
  deleted_paths: z.array(NativeDeletedPathSchema).default([]),
  renames: z.array(NativeRenameSchema).default([]),
});
export type NativeResultV2 = z.infer<typeof NativeResultV2Schema>;

export const NativeResultBundleV2Schema = z.object({
  version: z.literal(2),
  active_workflow_epoch: WorkflowEpochSchema.optional(),
  request_file: z.string().default('native-requests.jsonl'),
  capabilities: z
    .object({
      subagents: z.boolean().default(true),
      parallelism: z.boolean().default(false),
      browser: z.boolean().default(false),
    })
    .default({ subagents: true, parallelism: false, browser: false }),
  results: z.array(NativeResultV2Schema).default([]),
});

export type NativeResultBundleV2 = z.infer<typeof NativeResultBundleV2Schema>;

const identityFields = [
  'workflow_epoch',
  'request_id',
  'request_hash',
  'logical_task_id',
  'attempt_id',
  'generation',
  'lease_id',
  'idempotency_key',
] as const;
type NativeIdentity = Pick<NativeRequestV2, (typeof identityFields)[number]>;

const nativeResultPendingText = 'native result bundle has no result for task';

export function isNativeResultPendingSummary(summary: string): boolean {
  return summary.toLowerCase().includes(nativeResultPendingText);
}

function requestHashInput(task: AgentTask): Omit<NativeRequestV2, 'request_id' | 'request_hash'> {
  if (!task.attempt) {
    throw new Error(`Native protocol v2 requires a supervised attempt for task ${task.id}.`);
  }
  return {
    workflow_epoch: task.attempt.workflow_epoch,
    logical_task_id: task.attempt.logical_task_id,
    attempt_id: task.attempt.attempt_id,
    generation: task.attempt.generation,
    lease_id: task.attempt.lease_id,
    idempotency_key: task.attempt.idempotency_key,
    role: task.role,
    ...(task.tier ? { tier: task.tier } : {}),
    objective: task.objective,
    workspace_id: task.workspace?.id ?? null,
    canonical_files: task.canonical_files,
    code_files: task.code_files,
    write_scope: task.write_scope,
    acceptance_criteria: task.acceptance_criteria,
    verification_commands: task.verification_commands,
    return_format: task.return_format,
    notes: task.notes,
    expert_profiles: task.expert_profiles,
    result_contract: {
      protocol: 'NativeResultV2',
      identity_fields: [...identityFields],
      payload: 'A value that matches return_format.',
      files: 'Complete UTF-8 text keyed by project-relative target path.',
      artifacts: 'Binary files referenced by staged path, SHA-256, size, and media type.',
      preserved_files:
        'Files already changed in the exact assigned workspace, with workspace ID, current SHA-256, and baseline SHA-256.',
      deleted_paths: 'Deleted files with project-relative path and the expected pre-delete SHA-256.',
      renames: 'Renamed files with source path, target path, and the expected source SHA-256.',
      decision_proposals: 'Material decisions for deterministic validation before patch application.',
    },
  };
}

function stableWorkspacePath(task: AgentTask, value: string): string {
  if (!task.workspace || !path.isAbsolute(value)) return value;
  const root = path.resolve(task.workspace.root);
  const candidate = path.resolve(value);
  const relative = path.relative(root, candidate);
  if (relative === '') return '$WORKSPACE';
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) return value;
  return `$WORKSPACE/${relative.split(path.sep).join('/')}`;
}

function workspaceBaselineHash(
  workspaceRoot: string,
  relative: string,
): { available: true; hash: string | null } | { available: false; hash: null } {
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (
    topLevel.status !== 0 ||
    topLevel.error ||
    fs.realpathSync(topLevel.stdout.trim()) !== fs.realpathSync(workspaceRoot)
  ) {
    return { available: false, hash: null };
  }
  const tracked = spawnSync('git', ['ls-files', '--stage', '--', relative], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (tracked.status !== 0 || tracked.error) return { available: false, hash: null };
  if (tracked.stdout.trim() === '') return { available: true, hash: null };
  const baseline = spawnSync('git', ['show', `:./${relative}`], {
    cwd: workspaceRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (baseline.status !== 0 || baseline.error || !Buffer.isBuffer(baseline.stdout)) {
    return { available: false, hash: null };
  }
  return { available: true, hash: sha256(baseline.stdout) };
}

function semanticRequestPath(value: string, workspaceId: string | null): string {
  if (!workspaceId || !path.isAbsolute(value)) return value;
  const parts = path.normalize(value).split(path.sep);
  const workspaceIndex = parts.lastIndexOf(workspaceId);
  if (workspaceIndex < 1 || parts[workspaceIndex - 1] !== 'workspaces') return value;
  const relative = parts.slice(workspaceIndex + 1).join('/');
  return relative === '' ? '$WORKSPACE' : `$WORKSPACE/${relative}`;
}

function semanticRequest(request: NativeRequestV2): string {
  const {
    workflow_epoch: _workflowEpoch,
    request_id: _requestId,
    request_hash: _requestHash,
    attempt_id: _attemptId,
    generation: _generation,
    lease_id: _leaseId,
    idempotency_key: _idempotencyKey,
    ...body
  } = request;
  const notes = body.notes
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('[supervisor] previous attempt '))
    .join('\n');
  return JSON.stringify({
    ...body,
    workspace_id: body.workspace_id === null ? null : '$WORKSPACE',
    canonical_files: body.canonical_files.map((value) => semanticRequestPath(value, body.workspace_id)),
    code_files: body.code_files.map((value) => semanticRequestPath(value, body.workspace_id)),
    notes,
  });
}

export function createNativeRequestV2(task: AgentTask): NativeRequestV2 {
  const normalizedTask = AgentTaskSchema.parse(task);
  const body = requestHashInput(normalizedTask);
  // A native helper turn can create a fresh workspace with a different
  // absolute root. Hash the semantic task paths, not that random root, so the
  // exact supervised identity can resume while the request contains real paths.
  const hashBody = {
    ...body,
    workspace_id: body.workspace_id === null ? null : '$WORKSPACE',
    canonical_files: body.canonical_files.map((value) => stableWorkspacePath(normalizedTask, value)),
    code_files: body.code_files.map((value) => stableWorkspacePath(normalizedTask, value)),
  };
  const identity = JSON.stringify({
    workflow_epoch: body.workflow_epoch,
    logical_task_id: body.logical_task_id,
    attempt_id: body.attempt_id,
    generation: body.generation,
    lease_id: body.lease_id,
    idempotency_key: body.idempotency_key,
  });
  return NativeRequestV2Schema.parse({
    request_id: `nreq_${sha256(identity)}`,
    request_hash: sha256(JSON.stringify(hashBody)),
    ...body,
  });
}

export class NativeProtocolUpgradeError extends Error {
  constructor() {
    super('Native result protocol v1 is not valid in a native workflow. Archive it and create a v2 bundle.');
    this.name = 'NativeProtocolUpgradeError';
  }
}

/**
 * Ingest results produced by the active host's native subagents.
 *
 * This runner never starts a provider process. The host writes one result
 * bundle. RIJO replays each result through normal supervision and validation.
 */
export class NativeResultRunner implements AgentRunner {
  readonly capabilities: RunnerCapabilities;
  readonly workflowEpoch: WorkflowEpoch;
  private readonly entries: NativeResultV2[];
  private readonly used = new Set<number>();
  private readonly requestFile: string;
  private readonly bundleDirectory: string;

  constructor(bundleFile: string, expectedWorkflowEpoch?: WorkflowEpoch) {
    const raw = readJson<{
      version?: unknown;
      active_workflow_epoch?: unknown;
      results?: unknown[];
    }>(bundleFile);
    if (raw.version === 1) throw new NativeProtocolUpgradeError();
    const priorEpoch = WorkflowEpochSchema.safeParse(raw.active_workflow_epoch);
    const rawResults = Array.isArray(raw.results) ? raw.results : [];
    const exactResultEpochs = [
      ...new Set(
        rawResults.flatMap((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
          const parsed = WorkflowEpochSchema.safeParse(
            (entry as Record<string, unknown>)['workflow_epoch'],
          );
          return parsed.success ? [parsed.data] : [];
        }),
      ),
    ];
    const inferredExactEpoch =
      !priorEpoch.success &&
      expectedWorkflowEpoch === undefined &&
      exactResultEpochs.length === 1 &&
      rawResults.every(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>)['workflow_epoch'] === exactResultEpochs[0],
      )
        ? exactResultEpochs[0]
        : null;
    const workflowEpoch = WorkflowEpochSchema.parse(
      expectedWorkflowEpoch ??
        (priorEpoch.success
          ? priorEpoch.data
          : inferredExactEpoch ?? createWorkflowEpoch()),
    );
    const rotateForWorkflow =
      expectedWorkflowEpoch !== undefined &&
      (!priorEpoch.success || priorEpoch.data !== workflowEpoch);
    const hasEpochlessResult = rawResults.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        !('workflow_epoch' in entry),
    );
    if (hasEpochlessResult || rotateForWorkflow) {
      const archiveDir = path.join(
        path.dirname(path.resolve(bundleFile)),
        'native-v2-epochless-archive',
      );
      ensureDir(archiveDir);
      writeJsonAtomic(
        path.join(archiveDir, `${Date.now()}-${path.basename(bundleFile)}`),
        raw,
      );
    }
    const normalizedResults =
      hasEpochlessResult || rotateForWorkflow ? [] : rawResults;
    const normalizedRaw = {
      ...raw,
      active_workflow_epoch: workflowEpoch,
      results: normalizedResults,
    };
    if (
      !priorEpoch.success ||
      priorEpoch.data !== workflowEpoch ||
      hasEpochlessResult ||
      rotateForWorkflow
    ) {
      writeJsonAtomic(bundleFile, normalizedRaw);
    }
    const bundle = NativeResultBundleV2Schema.parse(normalizedRaw);
    this.workflowEpoch = workflowEpoch;
    this.capabilities = bundle.capabilities;
    this.entries = bundle.results;
    this.bundleDirectory = path.dirname(path.resolve(bundleFile));
    this.requestFile = path.resolve(this.bundleDirectory, bundle.request_file);
    assertContainedWithoutSymlinks(this.bundleDirectory, this.requestFile);
    this.rejectStaleStoredRequests(rotateForWorkflow);
  }

  private rejectStaleStoredRequests(rotateForWorkflow: boolean): void {
    if (!exists(this.requestFile)) return;
    const lines = readText(this.requestFile).split(/\r?\n/).filter(Boolean);
    const hasEpochlessRequest = lines.some((line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return value['workflow_epoch'] === undefined;
      } catch {
        return false;
      }
    });
    if (!hasEpochlessRequest && !rotateForWorkflow) return;
    const archiveDir = path.join(
      this.bundleDirectory,
      'native-v2-epochless-archive',
    );
    ensureDir(archiveDir);
    writeFileAtomic(
      path.join(archiveDir, `${Date.now()}-${path.basename(this.requestFile)}`),
      readText(this.requestFile),
    );
    writeFileAtomic(this.requestFile, '');
  }

  private storedRequests(): NativeRequestV2[] {
    if (!exists(this.requestFile)) return [];
    const requests: NativeRequestV2[] = [];
    for (const line of readText(this.requestFile).split(/\r?\n/).filter(Boolean)) {
      try {
        const parsed = NativeRequestV2Schema.safeParse(JSON.parse(line));
        if (parsed.success) requests.push(parsed.data);
      } catch {
        // Ignore a torn trailing request. It cannot authorize a result.
      }
    }
    return requests;
  }

  private storedRequestForTask(task: AgentTask, attempt: ReplayAttemptIdentity): NativeRequestV2 | null {
    const expected = createNativeRequestV2({
      ...task,
      attempt: {
        ...attempt,
        canonical_baseline_hash: task.canonical_baseline ?? null,
        workspace_id: task.workspace?.id ?? null,
      },
    });
    const requests = this.storedRequests();
    for (let index = requests.length - 1; index >= 0; index--) {
      const request = requests[index]!;
      if (
        request.workflow_epoch === attempt.workflow_epoch &&
        request.logical_task_id === attempt.logical_task_id &&
        request.attempt_id === attempt.attempt_id &&
        request.generation === attempt.generation &&
        request.lease_id === attempt.lease_id &&
        request.idempotency_key === attempt.idempotency_key &&
        semanticRequest(request) === semanticRequest(expected)
      ) {
        return request;
      }
    }
    return null;
  }

  replayAttempt(task: AgentTask): ReplayAttemptIdentity | null {
    const candidates: NativeIdentity[] = [];
    const usedRequestIds = new Set(
      [...this.used].map((index) => this.entries[index]?.request_id).filter((id): id is string => Boolean(id)),
    );
    for (let index = 0; index < this.entries.length; index++) {
      if (this.used.has(index)) continue;
      const entry = this.entries[index]!;
      candidates.push(entry);
    }
    for (const request of this.storedRequests()) {
      if (!usedRequestIds.has(request.request_id)) candidates.push(request);
    }

    for (const entry of candidates.reverse()) {
      if (entry.workflow_epoch !== this.workflowEpoch) continue;
      if (entry.logical_task_id !== task.id) continue;
      const attempt = {
        workflow_epoch: entry.workflow_epoch,
        logical_task_id: entry.logical_task_id,
        attempt_id: entry.attempt_id,
        generation: entry.generation,
        lease_id: entry.lease_id,
        idempotency_key: entry.idempotency_key,
        canonical_baseline_hash: task.canonical_baseline ?? null,
        workspace_id: task.workspace?.id ?? null,
      };
      const stored = this.storedRequestForTask(task, attempt);
      if (stored && identityFields.every((field) => entry[field] === stored[field])) {
        return {
          workflow_epoch: entry.workflow_epoch,
          logical_task_id: entry.logical_task_id,
          attempt_id: entry.attempt_id,
          generation: entry.generation,
          lease_id: entry.lease_id,
          idempotency_key: entry.idempotency_key,
        };
      }
    }
    return null;
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    const generatedRequest = createNativeRequestV2(task);
    const storedRequest = task.attempt
      ? this.storedRequestForTask(task, {
          workflow_epoch: task.attempt.workflow_epoch,
          logical_task_id: task.attempt.logical_task_id,
          attempt_id: task.attempt.attempt_id,
          generation: task.attempt.generation,
          lease_id: task.attempt.lease_id,
          idempotency_key: task.attempt.idempotency_key,
        })
      : null;
    const request = storedRequest ?? generatedRequest;
    const index = this.entries.findIndex((entry, candidate) => {
      if (this.used.has(candidate)) return false;
      return identityFields.every((field) => entry[field] === request[field]);
    });
    if (index < 0) {
      this.recordRequest(request);
      return this.result(task, {
        ok: false,
        summary: `The native result bundle has no result for task ${task.id} because no exact native identity matched.`,
        payload: null,
        scope_requests: [],
        decision_proposals: [],
      });
    }

    this.used.add(index);
    const entry = this.entries[index]!;
    const reject = (summary: string): AgentResult =>
      this.result(task, {
        ok: false,
        summary: `The native result bundle has no result for task ${task.id}: ${summary}`,
        payload: null,
        scope_requests: [],
        decision_proposals: [],
      });
    const fence = (summary: string): AgentResult =>
      this.result(task, {
        ok: false,
        summary,
        payload: null,
        scope_requests: [],
        decision_proposals: [],
      });
    const inlinePaths = Object.keys(entry.files);
    const artifactPaths = entry.artifacts.map((artifact) => artifact.target_path);
    const preservedPaths = entry.preserved_files.map((file) => file.target_path);
    const deletedPaths = entry.deleted_paths.map((operation) => operation.path);
    const renamedPaths = entry.renames.flatMap((operation) => [
      operation.source_path,
      operation.target_path,
    ]);
    const reported = [...new Set([
      ...entry.files_written,
      ...inlinePaths,
      ...artifactPaths,
      ...preservedPaths,
      ...deletedPaths,
      ...renamedPaths,
    ])];
    if (task.workspace) {
      for (const relative of reported) {
        if (!pathInScope(relative, task.write_scope)) {
          return reject(`Native result path is outside the task write scope: ${relative}.`);
        }
      }

      const claimedBy = new Map<string, string>();
      const claim = (relative: string, operation: string): AgentResult | null => {
        const prior = claimedBy.get(relative);
        if (prior) {
          return reject(`Native result path ${relative} is claimed by both ${prior} and ${operation}.`);
        }
        claimedBy.set(relative, operation);
        return null;
      };
      for (const relative of inlinePaths) {
        const conflict = claim(relative, 'inline files');
        if (conflict) return conflict;
      }
      for (const artifact of entry.artifacts) {
        const conflict = claim(artifact.target_path, 'artifact references');
        if (conflict) return conflict;
      }
      for (const file of entry.preserved_files) {
        const conflict = claim(file.target_path, 'preserved files');
        if (conflict) return conflict;
      }
      for (const operation of entry.deleted_paths) {
        const conflict = claim(operation.path, 'deleted paths');
        if (conflict) return conflict;
      }
      for (const operation of entry.renames) {
        const sourceConflict = claim(operation.source_path, 'rename sources');
        if (sourceConflict) return sourceConflict;
        const targetConflict = claim(operation.target_path, 'rename targets');
        if (targetConflict) return targetConflict;
      }

      for (const relative of entry.files_written) {
        if (!claimedBy.has(relative)) {
          return reject(
            `Native result declared ${relative} in files_written without inline bytes, an artifact reference, ` +
              'a preserved file hash, a deletion, or a rename.',
          );
        }
      }

      const absoluteAt = (root: string, relative: string): string => {
        const target = path.resolve(root, relative);
        assertContainedWithoutSymlinks(root, target);
        return target;
      };
      const absolute = (relative: string): string => absoluteAt(task.workspace!.root, relative);
      const replaySource = task.workspace.replay_source;
      if (replaySource) {
        const workspacesRoot = path.resolve(path.dirname(task.workspace.root));
        const sourceRoot = path.resolve(replaySource.root);
        const relativeSource = path.relative(workspacesRoot, sourceRoot);
        if (
          relativeSource === '' ||
          path.isAbsolute(relativeSource) ||
          relativeSource.split(path.sep).includes('..') ||
          path.basename(sourceRoot) !== replaySource.id ||
          !exists(sourceRoot) ||
          fs.lstatSync(sourceRoot).isSymbolicLink()
        ) {
          return reject('Native result replay workspace is invalid.');
        }
        for (const relative of reported) {
          const baseline = workspaceBaselineHash(sourceRoot, relative);
          if (!baseline.available) {
            return reject(`Native delayed result baseline is unavailable: ${relative}.`);
          }
          const currentTarget = absolute(relative);
          let currentHash: string | null = null;
          if (exists(currentTarget)) {
            if (!fs.lstatSync(currentTarget).isFile()) {
              return fence(`Native delayed result preimage conflict: ${relative} is not a regular file.`);
            }
            currentHash = sha256File(currentTarget);
          }
          if (currentHash !== baseline.hash) {
            return fence(
              `Native delayed result preimage conflict at ${relative}. ` +
                'The current workspace does not match the original attempt baseline.',
            );
          }
        }
      }
      const verifiedFileHash = (relative: string, purpose: string): string | AgentResult => {
        const target = absolute(relative);
        if (!exists(target) || !fs.lstatSync(target).isFile()) {
          return reject(`Native result ${purpose} source is missing or is not a regular file: ${relative}.`);
        }
        return sha256File(target);
      };

      const artifactBytes = new Map<string, Buffer>();
      for (const artifact of entry.artifacts) {
        const staged = path.resolve(this.bundleDirectory, artifact.staged_path);
        assertContainedWithoutSymlinks(this.bundleDirectory, staged);
        if (!exists(staged)) {
          return reject(`Native result artifact is missing: ${artifact.staged_path}.`);
        }
        const bytes = fs.readFileSync(staged);
        if (bytes.length !== artifact.size || sha256File(staged) !== artifact.sha256) {
          return reject(`Native result artifact integrity check failed: ${artifact.staged_path}.`);
        }
        absolute(artifact.target_path);
        artifactBytes.set(artifact.target_path, bytes);
      }
      const verifiedPreservedChanges = new Set<string>();
      const preservedBytes = new Map<string, Buffer>();
      for (const file of entry.preserved_files) {
        if (task.attempt?.workspace_id !== task.workspace.id) {
          return reject(`Native result target workspace identity is invalid: ${file.target_path}.`);
        }
        const source =
          file.workspace_id === task.workspace.id
            ? { id: task.workspace.id, root: task.workspace.root }
            : replaySource?.id === file.workspace_id
              ? replaySource
              : null;
        if (!source) {
          return reject(
            `Native result preserved file belongs to a different attempt workspace: ${file.target_path}.`,
          );
        }
        const sourceTarget = absoluteAt(source.root, file.target_path);
        if (!exists(sourceTarget) || !fs.lstatSync(sourceTarget).isFile()) {
          return reject(`Native result preserved file source is missing: ${file.target_path}.`);
        }
        const bytes = fs.readFileSync(sourceTarget);
        const actual = sha256(bytes);
        if (actual !== file.sha256) {
          return reject(`Native result preserved file hash mismatch: ${file.target_path}.`);
        }
        const baseline = workspaceBaselineHash(source.root, file.target_path);
        if (!baseline.available) {
          return reject(`Native result preserved file baseline is unavailable: ${file.target_path}.`);
        }
        if (baseline.hash !== file.baseline_sha256) {
          return reject(`Native result preserved file baseline hash mismatch: ${file.target_path}.`);
        }
        if (baseline.hash === actual) {
          return reject(`Native result preserved file has no delta from its attempt baseline: ${file.target_path}.`);
        }
        verifiedPreservedChanges.add(file.target_path);
        preservedBytes.set(file.target_path, bytes);
      }
      for (const operation of entry.deleted_paths) {
        const actual = verifiedFileHash(operation.path, 'deletion');
        if (typeof actual !== 'string') return actual;
        if (actual !== operation.sha256) {
          return reject(`Native result deletion hash mismatch: ${operation.path}.`);
        }
      }
      for (const operation of entry.renames) {
        const actual = verifiedFileHash(operation.source_path, 'rename');
        if (typeof actual !== 'string') return actual;
        if (actual !== operation.source_sha256) {
          return reject(`Native result rename hash mismatch: ${operation.source_path}.`);
        }
        const target = absolute(operation.target_path);
        if (exists(target)) {
          return reject(`Native result rename target already exists: ${operation.target_path}.`);
        }
      }

      const before = new Map<string, string | null>();
      for (const relative of reported) {
        const target = absolute(relative);
        before.set(relative, exists(target) && fs.lstatSync(target).isFile() ? sha256File(target) : null);
      }
      const predictedChanged = new Set<string>();
      for (const [relative, content] of Object.entries(entry.files)) {
        if (before.get(relative) !== sha256(content)) predictedChanged.add(relative);
      }
      for (const artifact of entry.artifacts) {
        if (before.get(artifact.target_path) !== artifact.sha256) predictedChanged.add(artifact.target_path);
      }
      for (const operation of entry.deleted_paths) predictedChanged.add(operation.path);
      for (const operation of entry.renames) {
        predictedChanged.add(operation.source_path);
        predictedChanged.add(operation.target_path);
      }
      for (const relative of verifiedPreservedChanges) predictedChanged.add(relative);
      const unchangedDeclared = entry.files_written.filter(
        (relative) => !predictedChanged.has(relative),
      );
      if (unchangedDeclared.length > 0) {
        return reject(
          `Native result declared writes without a materialized delta: ${unchangedDeclared.join(', ')}.`,
        );
      }
      if (entry.ok && task.write_scope.length > 0 && predictedChanged.size === 0) {
        return reject(`Native writer result for task ${task.id} did not materialize any file delta.`);
      }

      for (const [relative, content] of Object.entries(entry.files)) {
        writeFileAtomic(absolute(relative), content);
      }
      for (const artifact of entry.artifacts) {
        writeBufferAtomic(absolute(artifact.target_path), artifactBytes.get(artifact.target_path)!);
      }
      for (const file of entry.preserved_files) {
        writeBufferAtomic(absolute(file.target_path), preservedBytes.get(file.target_path)!);
      }
      for (const operation of entry.renames) {
        const source = absolute(operation.source_path);
        const target = absolute(operation.target_path);
        ensureDir(path.dirname(target));
        fs.renameSync(source, target);
      }
      for (const operation of entry.deleted_paths) {
        fs.rmSync(absolute(operation.path));
      }

      const changed = new Set<string>();
      for (const relative of reported) {
        const target = absolute(relative);
        const after = exists(target) && fs.lstatSync(target).isFile() ? sha256File(target) : null;
        if (before.get(relative) !== after) changed.add(relative);
      }
      if (
        [...predictedChanged].some(
          (relative) => !changed.has(relative) && !verifiedPreservedChanges.has(relative),
        )
      ) {
        return reject(`Native writer result for task ${task.id} did not produce its declared file delta.`);
      }
    } else if (reported.length > 0) {
      return reject(`Read-only task ${task.id} supplied file changes.`);
    }

    return this.result(task, entry, reported);
  }

  private recordRequest(request: NativeRequestV2): void {
    ensureDir(path.join(this.bundleDirectory, 'native-dispatch'));
    const prior = exists(this.requestFile)
      ? readText(this.requestFile)
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            try {
              return NativeRequestV2Schema.safeParse(JSON.parse(line));
            } catch {
              return null;
            }
          })
          .find((parsed) => parsed?.success && parsed.data.request_id === request.request_id)
      : undefined;
    if (prior?.success) {
      if (prior.data.request_hash !== request.request_hash) {
        throw new Error(`Native request identity ${request.request_id} was reused with different task content.`);
      }
      return;
    }
    appendLine(
      this.requestFile,
      JSON.stringify(request),
    );
  }

  private result(
    task: AgentTask,
    entry: Pick<NativeResultV2, 'ok' | 'summary' | 'payload' | 'scope_requests' | 'decision_proposals'>,
    filesWritten: string[] = [],
  ): AgentResult {
    return {
      task_id: task.id,
      ok: entry.ok,
      summary: entry.summary,
      payload: entry.payload,
      files_written: filesWritten,
      scope_requests: entry.scope_requests,
      decision_proposals: entry.decision_proposals,
      workflow_epoch: task.attempt?.workflow_epoch ?? this.workflowEpoch,
      attempt_id: task.attempt?.attempt_id ?? null,
      generation: task.attempt?.generation ?? null,
      lease_id: task.attempt?.lease_id ?? null,
    };
  }
}
