import * as path from 'node:path';
import { z } from 'zod';
import {
  appendLine,
  assertContainedWithoutSymlinks,
  exists,
  readJson,
  readText,
  writeFileAtomic,
} from '../core/fsx.js';
import { pathInScope } from '../core/scope.js';
import type { AgentResult, AgentTask } from './protocol.js';
import type { AgentRunner, RunnerCapabilities } from './runner.js';

const NativeResultEntrySchema = z
  .object({
    task_id: z.string().optional(),
    match_prefix: z.string().optional(),
    ok: z.boolean(),
    summary: z.string().min(1),
    payload: z.unknown().nullable().default(null),
    files: z.record(z.string(), z.string()).default({}),
    files_written: z.array(z.string()).optional(),
    scope_requests: z.array(z.string()).default([]),
  })
  .refine((entry) => Boolean(entry.task_id || entry.match_prefix), {
    message: 'Each native result needs task_id or match_prefix.',
  });

const NativeResultBundleSchema = z.object({
  version: z.literal(1),
  request_file: z.string().default('native-requests.jsonl'),
  capabilities: z
    .object({
      subagents: z.boolean().default(true),
      parallelism: z.boolean().default(false),
      browser: z.boolean().default(false),
    })
    .default({ subagents: true, parallelism: false, browser: false }),
  results: z.array(NativeResultEntrySchema).default([]),
});

type NativeResultEntry = z.infer<typeof NativeResultEntrySchema>;

/**
 * Ingest results produced by the active host's native subagents.
 *
 * This runner never starts a provider process. The host writes one result
 * bundle. RIJO replays each result through normal supervision and validation.
 */
export class NativeResultRunner implements AgentRunner {
  readonly capabilities: RunnerCapabilities;
  private readonly entries: NativeResultEntry[];
  private readonly used = new Set<number>();
  private readonly requestFile: string;

  constructor(bundleFile: string) {
    const bundle = NativeResultBundleSchema.parse(readJson(bundleFile));
    this.capabilities = bundle.capabilities;
    this.entries = bundle.results;
    const bundleDirectory = path.dirname(path.resolve(bundleFile));
    this.requestFile = path.resolve(bundleDirectory, bundle.request_file);
    assertContainedWithoutSymlinks(bundleDirectory, this.requestFile);
  }

  async runTask(task: AgentTask): Promise<AgentResult> {
    const index = this.entries.findIndex((entry, candidate) => {
      if (this.used.has(candidate)) return false;
      return (
        entry.task_id === task.id ||
        (entry.match_prefix !== undefined && task.id.startsWith(entry.match_prefix))
      );
    });
    if (index < 0) {
      this.recordRequest(task);
      return this.result(task, {
        ok: false,
        summary: `The native result bundle has no result for task ${task.id}.`,
        payload: null,
        scope_requests: [],
      });
    }

    this.used.add(index);
    const entry = this.entries[index]!;
    const reported = entry.files_written ?? Object.keys(entry.files);
    if (task.workspace) {
      for (const [relative, content] of Object.entries(entry.files)) {
        if (!pathInScope(relative, task.write_scope)) {
          return this.result(task, {
            ok: false,
            summary: `Native result file is outside the task write scope: ${relative}.`,
            payload: null,
            scope_requests: [],
          });
        }
        const target = path.resolve(task.workspace.root, relative);
        assertContainedWithoutSymlinks(task.workspace.root, target);
        writeFileAtomic(target, content);
      }
    } else if (Object.keys(entry.files).length > 0) {
      return this.result(task, {
        ok: false,
        summary: `Read-only task ${task.id} supplied file changes.`,
        payload: null,
        scope_requests: [],
      });
    }

    return this.result(task, entry, reported);
  }

  private recordRequest(task: AgentTask): void {
    const prior = exists(this.requestFile)
      ? readText(this.requestFile)
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .some((line) => {
            try {
              return (JSON.parse(line) as { task_id?: string }).task_id === task.id;
            } catch {
              return false;
            }
          })
      : false;
    if (prior) return;
    appendLine(
      this.requestFile,
      JSON.stringify({
        task_id: task.id,
        role: task.role,
        tier: task.tier,
        objective: task.objective,
        canonical_files: task.canonical_files,
        code_files: task.code_files,
        write_scope: task.write_scope,
        acceptance_criteria: task.acceptance_criteria,
        verification_commands: task.verification_commands,
        return_format: task.return_format,
        notes: task.notes,
        expert_profiles: task.expert_profiles,
      }),
    );
  }

  private result(
    task: AgentTask,
    entry: Pick<NativeResultEntry, 'ok' | 'summary' | 'payload' | 'scope_requests'>,
    filesWritten: string[] = [],
  ): AgentResult {
    return {
      task_id: task.id,
      ok: entry.ok,
      summary: entry.summary,
      payload: entry.payload,
      files_written: filesWritten,
      scope_requests: entry.scope_requests,
      attempt_id: task.attempt?.attempt_id ?? null,
      generation: task.attempt?.generation ?? null,
      lease_id: task.attempt?.lease_id ?? null,
    };
  }
}
