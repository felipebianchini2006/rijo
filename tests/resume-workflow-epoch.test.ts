import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WorkflowOperationSchema,
  createWorkflowEpoch,
  workflowOperationKey,
  type WorkflowOperation,
} from '../src/core/workflow-epoch.js';
import { selectActiveResumeRoute } from '../src/workflows/resume.js';

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-resume-epoch-'));
}

function marker(
  root: string,
  operation: string,
  operationArgs: string[],
): WorkflowOperation {
  const now = new Date().toISOString();
  return WorkflowOperationSchema.parse({
    workflow_epoch: createWorkflowEpoch(),
    operation,
    operation_key: workflowOperationKey(root, operation, operationArgs),
    operation_args: operationArgs,
    status: 'ACTIVE',
    opened_at: now,
    updated_at: now,
    terminal_status: null,
  });
}

describe('active workflow resume routing', () => {
  it('routes every supported active marker to its exact workflow inputs', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(root, 'NEXT.md'), '# Next\n');
    fs.writeFileSync(path.join(root, 'design.html'), '<main>Design</main>\n');
    fs.writeFileSync(path.join(root, 'evidence.txt'), 'Failure evidence.\n');

    expect(
      selectActiveResumeRoute(root, marker(root, 'map-codebase', [])),
    ).toEqual({ route: 'map-codebase' });
    expect(
      selectActiveResumeRoute(root, marker(root, 'new', ['@PLAN.md'])),
    ).toEqual({ route: 'new', planFile: '@PLAN.md' });
    expect(
      selectActiveResumeRoute(root, marker(root, 'ui', ['@design.html'])),
    ).toEqual({ route: 'ui', inputs: ['@design.html'] });
    expect(
      selectActiveResumeRoute(root, marker(root, 'next', ['@NEXT.md'])),
    ).toEqual({ route: 'next', planFile: '@NEXT.md' });
    expect(
      selectActiveResumeRoute(root, marker(root, 'start', [])),
    ).toEqual({ route: 'start' });
    expect(
      selectActiveResumeRoute(root, marker(root, 'test', [])),
    ).toEqual({ route: 'test' });
    expect(
      selectActiveResumeRoute(
        root,
        marker(root, 'fix', ['checkout-error', '@evidence.txt']),
      ),
    ).toEqual({
      route: 'fix',
      options: {
        description: 'checkout-error',
        evidenceFiles: ['evidence.txt'],
      },
    });
    expect(
      selectActiveResumeRoute(root, marker(root, 'finish', [])),
    ).toEqual({ route: 'finish' });
  });

  it('treats a fix description as a literal and checks only evidence paths', () => {
    const root = fixture();
    const args = ['checkout-error', '@evidence.txt'];
    fs.writeFileSync(path.join(root, 'evidence.txt'), 'Initial evidence.\n');
    const active = marker(root, 'fix', args);
    const firstKey = active.operation_key;

    fs.writeFileSync(path.join(root, 'checkout-error'), 'A same-named file.\n');
    expect(workflowOperationKey(root, 'fix', args)).toBe(firstKey);
    expect(selectActiveResumeRoute(root, active)).toMatchObject({
      route: 'fix',
      options: { description: 'checkout-error' },
    });

    fs.rmSync(path.join(root, 'evidence.txt'));
    expect(selectActiveResumeRoute(root, active)).toMatchObject({
      route: 'blocked',
      reason: expect.stringContaining('immutable inputs'),
    });
  });

  it('blocks input-bearing operations when immutable inputs are absent or changed', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'PLAN.md'), '# Initial plan\n');
    const active = marker(root, 'new', ['@PLAN.md']);
    fs.writeFileSync(path.join(root, 'PLAN.md'), '# Changed plan\n');

    expect(selectActiveResumeRoute(root, active)).toMatchObject({
      route: 'blocked',
      reason: expect.stringContaining('immutable inputs'),
    });
    expect(
      selectActiveResumeRoute(
        root,
        WorkflowOperationSchema.parse({
          ...active,
          operation_args: [],
          operation_key: workflowOperationKey(root, 'new', []),
        }),
      ),
    ).toMatchObject({
      route: 'blocked',
      reason: expect.stringContaining('approved plan input'),
    });
  });
});
