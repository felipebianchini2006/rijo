import { AttemptWorkspace } from '../core/workspace.js';
import type { WorkflowContext } from '../workflows/shared.js';
import {
  BaselineDocumentSchema,
  type BaselineDocument,
  type BaselineStatus,
  type InventoryDocument,
} from './schemas.js';

export function runBaseline(
  ctx: WorkflowContext,
  inventory: InventoryDocument,
  commit: string | null,
  treeHash: string | null,
  execute = true,
): BaselineDocument {
  if (inventory.detected_commands.length === 0) {
    return BaselineDocumentSchema.parse({ overall_status: 'NOT_AVAILABLE', commands: [] });
  }
  if (!execute) {
    return BaselineDocumentSchema.parse({
      overall_status: 'DETECTED_NOT_RUN',
      commands: inventory.detected_commands.map((item) => ({
        ...item,
        status: 'DETECTED_NOT_RUN',
        commit,
        tree_hash: treeHash,
        duration_ms: null,
        exit_code: null,
        output: '',
        sandbox: null,
      })),
    });
  }

  const workspace = AttemptWorkspace.create(ctx.projectRoot, {
    taskId: 'map-baseline',
    writeScope: ['**'],
    canonicalWriteScope: [],
    baselineCommit: commit,
    baselineCanonicalHash: treeHash ?? '',
  });
  try {
    const commands = inventory.detected_commands.map((item) => {
      const evidence = ctx.shell.run(item.command, { cwd: workspace.root });
      const status: BaselineStatus = evidence.blocked
        ? 'BLOCKED_BY_SANDBOX'
        : evidence.exit_code === 0
          ? 'PASSED'
          : 'FAILED';
      return {
        ...item,
        status,
        commit,
        tree_hash: treeHash,
        duration_ms: evidence.duration_ms,
        exit_code: evidence.exit_code,
        output: evidence.summary,
        sandbox: evidence.sandbox ?? null,
      };
    });
    const statuses = new Set(commands.map((item) => item.status));
    const overall: BaselineStatus = statuses.has('BLOCKED_BY_SANDBOX')
      ? 'BLOCKED_BY_SANDBOX'
      : statuses.has('FAILED')
        ? 'FAILED'
        : 'PASSED';
    return BaselineDocumentSchema.parse({ overall_status: overall, commands });
  } finally {
    workspace.discard();
  }
}

