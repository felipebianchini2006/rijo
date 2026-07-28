import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { RijoPaths } from './paths.js';
import { readJsonIfExists, sha256, writeJsonAtomic } from './fsx.js';

export const WorkflowEpochSchema = z.string().regex(/^wep_[a-f0-9]{64}$/);
export type WorkflowEpoch = z.infer<typeof WorkflowEpochSchema>;
export const LEGACY_WORKFLOW_EPOCH = WorkflowEpochSchema.parse(
  `wep_${'0'.repeat(64)}`,
);

export const WorkflowOperationSchema = z.object({
  workflow_epoch: WorkflowEpochSchema,
  operation: z.string().min(1),
  operation_key: z.string().min(1),
  operation_args: z.array(z.string()).default([]),
  status: z.enum(['ACTIVE', 'TERMINAL']),
  opened_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  terminal_status: z
    .enum(['completed', 'not_ready', 'blocked', 'failed'])
    .nullable()
    .default(null),
});
export type WorkflowOperation = z.infer<typeof WorkflowOperationSchema>;

export function createWorkflowEpoch(): WorkflowEpoch {
  return WorkflowEpochSchema.parse(`wep_${sha256(randomUUID())}`);
}

/**
 * Hash only the immutable public command inputs. The operation marker stores
 * the original arguments so resume can select the exact workflow again.
 */
export function workflowOperationKey(
  projectRoot: string,
  operation: string,
  operationArgs: string[],
): string {
  const content = operationArgs.map((argument) => {
    if (!argument.startsWith('@')) {
      return { kind: 'literal', value: argument };
    }
    const value = argument.slice(1);
    const candidate = path.resolve(projectRoot, value);
    if (!fs.existsSync(candidate)) return { kind: 'path', value, sha256: null };
    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
      return { kind: 'path', value, sha256: sha256(fs.readFileSync(candidate)) };
    }
    if (stat.isDirectory()) {
      const files: Array<{ path: string; sha256: string }> = [];
      const visit = (directory: string): void => {
        for (const name of fs.readdirSync(directory).sort()) {
          const absolute = path.join(directory, name);
          const entry = fs.lstatSync(absolute);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) visit(absolute);
          else if (entry.isFile()) {
            files.push({
              path: path.relative(candidate, absolute).split(path.sep).join('/'),
              sha256: sha256(fs.readFileSync(absolute)),
            });
          }
        }
      };
      visit(candidate);
      return { kind: 'path', value, sha256: sha256(JSON.stringify(files)) };
    }
    return { kind: 'path', value, sha256: null };
  });
  return sha256(JSON.stringify({ operation, content }));
}

export function workflowOperationPath(paths: RijoPaths): string {
  return path.join(paths.runtimeDir, 'native-workflow.json');
}

function workflowOperationArchivePath(
  paths: RijoPaths,
  operation: WorkflowOperation,
): string {
  return path.join(
    paths.runtimeDir,
    'workflow-epochs',
    `${operation.workflow_epoch}.json`,
  );
}

export function readWorkflowOperation(paths: RijoPaths): WorkflowOperation | null {
  const parsed = WorkflowOperationSchema.safeParse(
    readJsonIfExists(workflowOperationPath(paths)),
  );
  return parsed.success ? parsed.data : null;
}

/** Start one explicitly authorized public workflow operation. */
export function openWorkflowOperation(
  paths: RijoPaths,
  operation: string,
  operationKey: string,
  operationArgs: string[] = [],
  now: () => Date = () => new Date(),
): WorkflowOperation {
  const current = readWorkflowOperation(paths);
  if (current?.status === 'ACTIVE') {
    if (
      current.operation === operation &&
      current.operation_key === operationKey
    ) {
      return current;
    }
    throw new Error(
      `Native workflow ${current.operation} is active. Resume or complete it before ${operation}.`,
    );
  }
  if (current) {
    const archivePath = workflowOperationArchivePath(paths, current);
    const archived = readJsonIfExists(archivePath);
    if (archived === null) {
      writeJsonAtomic(archivePath, current);
    } else {
      const parsed = WorkflowOperationSchema.safeParse(archived);
      if (
        !parsed.success ||
        JSON.stringify(parsed.data) !== JSON.stringify(current)
      ) {
        throw new Error('The native workflow epoch archive conflicts with the terminal marker.');
      }
    }
  }
  const timestamp = now().toISOString();
  const record = WorkflowOperationSchema.parse({
    workflow_epoch: createWorkflowEpoch(),
    operation,
    operation_key: operationKey,
    operation_args: operationArgs,
    status: 'ACTIVE',
    opened_at: timestamp,
    updated_at: timestamp,
    terminal_status: null,
  });
  writeJsonAtomic(workflowOperationPath(paths), record);
  return record;
}

/** Reuse only the exact active operation. A different active operation fails closed. */
export function requireWorkflowOperation(
  paths: RijoPaths,
  operation: string,
  operationKey: string,
): WorkflowOperation {
  const current = readWorkflowOperation(paths);
  if (!current) {
    throw new Error(
      `No native ${operation} workflow is open. Run the workflow-open helper once for this public command.`,
    );
  }
  if (
    current.operation !== operation ||
    current.operation_key !== operationKey
  ) {
    throw new Error(
      `Native workflow ${current.operation} is still ${current.status}. Resume or complete it before ${operation}.`,
    );
  }
  if (current.status === 'TERMINAL') {
    throw new Error(
      `Native workflow ${operation} is already terminal. Open a new public command before another helper turn.`,
    );
  }
  return current;
}

export function markWorkflowOperationTerminal(
  paths: RijoPaths,
  workflowEpoch: WorkflowEpoch,
  status: 'completed' | 'not_ready' | 'blocked' | 'failed',
  now: () => Date = () => new Date(),
): WorkflowOperation {
  const current = readWorkflowOperation(paths);
  if (!current || current.workflow_epoch !== workflowEpoch) {
    throw new Error('The native workflow epoch changed before terminal recording.');
  }
  if (current.status === 'TERMINAL') return current;
  const terminal = WorkflowOperationSchema.parse({
    ...current,
    status: 'TERMINAL',
    terminal_status: status,
    updated_at: now().toISOString(),
  });
  writeJsonAtomic(workflowOperationPath(paths), terminal);
  return terminal;
}

export function resumeWorkflowEpoch(paths: RijoPaths): WorkflowEpoch | null {
  const current = readWorkflowOperation(paths);
  return current?.status === 'ACTIVE' ? current.workflow_epoch : null;
}
