import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  appendLine,
  assertContainedWithoutSymlinks,
  exists,
  readJson,
  readText,
  sha256,
  sha256File,
  writeBufferAtomic,
  writeFileAtomic,
} from '../core/fsx.js';
import { pathInScope } from '../core/scope.js';
import type { AgentResult, AgentTask } from './protocol.js';
import type { AgentRunner, RunnerCapabilities } from './runner.js';

const NativeIdentitySchema = z.object({
  request_id: z.string().regex(/^nreq_[a-f0-9]{64}$/),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  logical_task_id: z.string().min(1),
  attempt_id: z.string().min(1),
  generation: z.number().int().min(1),
  lease_id: z.string().min(1),
  idempotency_key: z.string().min(1),
});

export const NativeArtifactReferenceSchema = z.object({
  target_path: z.string().min(1),
  staged_path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0),
  media_type: z.string().min(1),
});
export type NativeArtifactReference = z.infer<typeof NativeArtifactReferenceSchema>;

export const NativeRequestV2Schema = NativeIdentitySchema.extend({
  role: z.string().min(1),
  tier: z.string().optional(),
  objective: z.string().min(1),
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
    decision_proposals: z.string(),
  }),
});
export type NativeRequestV2 = z.infer<typeof NativeRequestV2Schema>;

export const NativeResultV2Schema = NativeIdentitySchema.extend({
  ok: z.boolean(),
  summary: z.string().min(1),
  payload: z.unknown().nullable().default(null),
  files: z.record(z.string(), z.string()).default({}),
  files_written: z.array(z.string()).default([]),
  scope_requests: z.array(z.string()).default([]),
  decision_proposals: z.array(z.unknown()).default([]),
  artifacts: z.array(NativeArtifactReferenceSchema).default([]),
});
export type NativeResultV2 = z.infer<typeof NativeResultV2Schema>;

export const NativeResultBundleV2Schema = z.object({
  version: z.literal(2),
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
  'request_id',
  'request_hash',
  'logical_task_id',
  'attempt_id',
  'generation',
  'lease_id',
  'idempotency_key',
] as const;

function requestHashInput(task: AgentTask): Omit<NativeRequestV2, 'request_id' | 'request_hash'> {
  if (!task.attempt) {
    throw new Error(`Native protocol v2 requires a supervised attempt for task ${task.id}.`);
  }
  return {
    logical_task_id: task.attempt.logical_task_id,
    attempt_id: task.attempt.attempt_id,
    generation: task.attempt.generation,
    lease_id: task.attempt.lease_id,
    idempotency_key: task.attempt.idempotency_key,
    role: task.role,
    ...(task.tier ? { tier: task.tier } : {}),
    objective: task.objective,
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
      decision_proposals: 'Material decisions for deterministic validation before patch application.',
    },
  };
}

export function createNativeRequestV2(task: AgentTask): NativeRequestV2 {
  const body = requestHashInput(task);
  const identity = JSON.stringify({
    logical_task_id: body.logical_task_id,
    attempt_id: body.attempt_id,
    generation: body.generation,
    lease_id: body.lease_id,
    idempotency_key: body.idempotency_key,
  });
  return NativeRequestV2Schema.parse({
    request_id: `nreq_${sha256(identity)}`,
    request_hash: sha256(JSON.stringify(body)),
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
  private readonly entries: NativeResultV2[];
  private readonly used = new Set<number>();
  private readonly requestFile: string;
  private readonly bundleDirectory: string;

  constructor(bundleFile: string) {
    const raw = readJson<{ version?: unknown }>(bundleFile);
    if (raw.version === 1) throw new NativeProtocolUpgradeError();
    const bundle = NativeResultBundleV2Schema.parse(raw);
    this.capabilities = bundle.capabilities;
    this.entries = bundle.results;
    this.bundleDirectory = path.dirname(path.resolve(bundleFile));
    this.requestFile = path.resolve(this.bundleDirectory, bundle.request_file);
    assertContainedWithoutSymlinks(this.bundleDirectory, this.requestFile);
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    const request = createNativeRequestV2(task);
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
    const reported = [...new Set([
      ...entry.files_written,
      ...Object.keys(entry.files),
      ...entry.artifacts.map((artifact) => artifact.target_path),
    ])];
    if (task.workspace) {
      for (const [relative, content] of Object.entries(entry.files)) {
        if (!pathInScope(relative, task.write_scope)) {
          return this.result(task, {
            ok: false,
            summary: `Native result file is outside the task write scope: ${relative}.`,
            payload: null,
            scope_requests: [],
            decision_proposals: [],
          });
        }
        const target = path.resolve(task.workspace.root, relative);
        assertContainedWithoutSymlinks(task.workspace.root, target);
        writeFileAtomic(target, content);
      }
      for (const artifact of entry.artifacts) {
        if (!pathInScope(artifact.target_path, task.write_scope)) {
          return this.result(task, {
            ok: false,
            summary: `Native result artifact is outside the task write scope: ${artifact.target_path}.`,
            payload: null,
            scope_requests: [],
            decision_proposals: [],
          });
        }
        const staged = path.resolve(this.bundleDirectory, artifact.staged_path);
        assertContainedWithoutSymlinks(this.bundleDirectory, staged);
        if (!exists(staged)) {
          return this.result(task, {
            ok: false,
            summary: `Native result artifact is missing: ${artifact.staged_path}.`,
            payload: null,
            scope_requests: [],
            decision_proposals: [],
          });
        }
        const bytes = fs.readFileSync(staged);
        if (bytes.length !== artifact.size || sha256File(staged) !== artifact.sha256) {
          return this.result(task, {
            ok: false,
            summary: `Native result artifact integrity check failed: ${artifact.staged_path}.`,
            payload: null,
            scope_requests: [],
            decision_proposals: [],
          });
        }
        const target = path.resolve(task.workspace.root, artifact.target_path);
        assertContainedWithoutSymlinks(task.workspace.root, target);
        writeBufferAtomic(target, bytes);
      }
    } else if (Object.keys(entry.files).length > 0) {
      return this.result(task, {
        ok: false,
        summary: `Read-only task ${task.id} supplied file changes.`,
          payload: null,
          scope_requests: [],
          decision_proposals: [],
        });
    } else if (entry.artifacts.length > 0) {
      return this.result(task, {
        ok: false,
        summary: `Read-only task ${task.id} supplied binary artifacts.`,
        payload: null,
        scope_requests: [],
        decision_proposals: [],
      });
    }

    return this.result(task, entry, reported);
  }

  private recordRequest(request: NativeRequestV2): void {
    const prior = exists(this.requestFile)
      ? readText(this.requestFile)
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .some((line) => {
            try {
              return (JSON.parse(line) as { request_id?: string }).request_id === request.request_id;
            } catch {
              return false;
            }
          })
      : false;
    if (prior) return;
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
      attempt_id: task.attempt?.attempt_id ?? null,
      generation: task.attempt?.generation ?? null,
      lease_id: task.attempt?.lease_id ?? null,
    };
  }
}
