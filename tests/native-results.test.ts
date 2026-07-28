import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeProtocolUpgradeError,
  NativeResultRunner,
  createNativeRequestV2,
} from '../src/agents/native-results.js';
import { AgentTaskSchema } from '../src/agents/protocol.js';
import { detectDrift } from '../src/core/manifest.js';
import { RijoPaths } from '../src/core/paths.js';
import { newWorkflow } from '../src/workflows/new.js';
import { startWorkflow } from '../src/workflows/run.js';
import { cleanup, deps, tmpProject, writePlanFile } from './helpers.js';

describe('native result ingestion', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) cleanup(root);
  });

  const attempt = {
    logical_task_id: 'plan-01',
    attempt_id: 'attempt-01',
    generation: 1,
    lease_id: 'lease-01',
    idempotency_key: 'plan-01:1',
    canonical_baseline_hash: null,
    workspace_id: null,
  };

  it('exports a complete v2 request without starting a host process', async () => {
    const root = tmpProject('rijo-native-request-');
    roots.push(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const runner = new NativeResultRunner(bundle);
    const task = AgentTaskSchema.parse({
      id: 'plan-01',
      role: 'planner',
      objective: 'Create the bounded phase plan.',
      canonical_files: [],
      code_files: [],
      write_scope: [],
      acceptance_criteria: ['The plan covers the phase.'],
      verification_commands: [],
      return_format: 'JSON plan payload.',
      attempt,
    });

    const result = await runner.runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('no result for task plan-01');
    const request = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );
    expect(request.logical_task_id).toBe('plan-01');
    expect(request.attempt_id).toBe('attempt-01');
    expect(request.generation).toBe(1);
    expect(request.lease_id).toBe('lease-01');
    expect(request.idempotency_key).toBe('plan-01:1');
    expect(request.request_id).toMatch(/^nreq_[a-f0-9]{64}$/);
    expect(request.request_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(request.objective).toBe(task.objective);
    expect(request.result_contract.protocol).toBe('NativeResultV2');
    expect(request.result_contract.identity_fields).toEqual([
      'request_id',
      'request_hash',
      'logical_task_id',
      'attempt_id',
      'generation',
      'lease_id',
      'idempotency_key',
    ]);
  });

  it('rejects a v1 bundle in the native workflow', () => {
    const root = tmpProject('rijo-native-v1-');
    roots.push(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 1, results: [] }));
    expect(() => new NativeResultRunner(bundle)).toThrow(NativeProtocolUpgradeError);
  });

  it('does not create plan correction requests before the native host returns a result', async () => {
    const root = tmpProject('rijo-native-project-init-');
    roots.push(root);
    writePlanFile(root, 'PLAN.md', '# Plan\n\nCreate one local TypeScript file.\n');
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const runtime = deps(root);

    await expect(
      newWorkflow(root, { planFile: '@PLAN.md' }, {
        ...runtime,
        runner: new NativeResultRunner(bundle),
      }),
    ).rejects.toThrow('NATIVE_RESULT_REQUIRED');
    const requests = fs
      .readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { logical_task_id: string });
    expect(requests.map((request) => request.logical_task_id)).toEqual(['new-extract']);
  });

  it('applies a native writer result only inside the assigned workspace scope', async () => {
    const root = tmpProject('rijo-native-writer-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'exec-01-T01',
      role: 'worker',
      objective: 'Implement one feature.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/feature.ts'],
      acceptance_criteria: ['The feature exists.'],
      verification_commands: ['npm test'],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: {
        ...attempt,
        logical_task_id: 'exec-01-T01',
        workspace_id: 'native-workspace',
      },
    });
    const request = createNativeRequestV2(task);
    fs.writeFileSync(
      bundle,
      JSON.stringify({
        version: 2,
        results: [
          {
            ...request,
            ok: true,
            summary: 'Implemented the bounded task.',
            payload: { done: true },
            files: { 'src/feature.ts': 'export const feature = true;\n' },
            files_written: ['src/feature.ts'],
            scope_requests: [],
            decision_proposals: [{ id: 'decision-01' }],
            artifacts: [],
          },
        ],
      }),
    );
    const runner = new NativeResultRunner(bundle);

    const result = await runner.runTask(task);

    expect(result.ok).toBe(true);
    expect(result.files_written).toEqual(['src/feature.ts']);
    expect(result.decision_proposals).toEqual([{ id: 'decision-01' }]);
    expect(fs.readFileSync(path.join(workspace, 'src', 'feature.ts'), 'utf8')).toContain(
      'feature = true',
    );
  });

  it('rejects a stale generation and never stamps it as current', async () => {
    const root = tmpProject('rijo-native-stale-');
    roots.push(root);
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'plan-01',
      role: 'planner',
      objective: 'Create the bounded phase plan.',
      canonical_files: [],
      code_files: [],
      write_scope: [],
      acceptance_criteria: ['The plan covers the phase.'],
      verification_commands: [],
      return_format: 'JSON plan payload.',
      attempt: { ...attempt, generation: 2, attempt_id: 'attempt-02', lease_id: 'lease-02' },
    });
    const stale = createNativeRequestV2({
      ...task,
      attempt: { ...attempt, generation: 1, attempt_id: 'attempt-01', lease_id: 'lease-01' },
    });
    fs.writeFileSync(
      bundle,
      JSON.stringify({
        version: 2,
        results: [
          {
            ...stale,
            ok: true,
            summary: 'Late result.',
            payload: {},
            files: {},
            files_written: [],
            scope_requests: [],
            artifacts: [],
          },
        ],
      }),
    );

    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('no exact native identity');
    expect(result.attempt_id).toBe('attempt-02');
    expect(result.generation).toBe(2);
    expect(result.lease_id).toBe('lease-02');
  });

  it('copies a verified binary artifact without placing bytes in JSON', async () => {
    const root = tmpProject('rijo-native-artifact-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const staging = path.join(root, 'staging');
    fs.mkdirSync(workspace);
    fs.mkdirSync(staging);
    const binary = Buffer.from([0, 1, 2, 254, 255]);
    const staged = path.join(staging, 'logo.bin');
    fs.writeFileSync(staged, binary);
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'exec-binary',
      role: 'worker',
      objective: 'Install the verified binary asset.',
      canonical_files: [],
      code_files: [],
      write_scope: ['public/logo.bin'],
      acceptance_criteria: ['The asset matches the source hash.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: {
        ...attempt,
        logical_task_id: 'exec-binary',
        workspace_id: 'native-workspace',
      },
    });
    const request = createNativeRequestV2(task);
    fs.writeFileSync(
      bundle,
      JSON.stringify({
        version: 2,
        results: [
          {
            ...request,
            ok: true,
            summary: 'Installed the binary asset.',
            payload: null,
            files: {},
            files_written: ['public/logo.bin'],
            scope_requests: [],
            artifacts: [
              {
                target_path: 'public/logo.bin',
                staged_path: 'staging/logo.bin',
                sha256: '103597c5abb6113da596c18e9d1da69364eafe00a2bfaa8b12e53c44bd6b0429',
                size: 5,
                media_type: 'application/octet-stream',
              },
            ],
          },
        ],
      }),
    );

    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'public', 'logo.bin'))).toEqual(binary);
  });

  it('keeps the phase checkpoint valid while it waits for a native result', async () => {
    const root = tmpProject('rijo-native-phase-open-');
    roots.push(root);
    writePlanFile(root, 'PLAN.md');
    const runtime = deps(root);
    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, runtime)).ok).toBe(true);
    const paths = new RijoPaths(root);
    const bundle = path.join(paths.runtimeDir, 'native-results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));

    const pending = expect(
      startWorkflow(root, {
        ...runtime,
        runner: new NativeResultRunner(bundle),
      }),
    ).rejects;
    await pending.toThrow('NATIVE_RESULT_REQUIRED');
    await pending.not.toThrow(/BLOCKED|exhausted/);

    expect(detectDrift(paths)).toEqual({ drifted: [], missing: [] });
    expect(fs.existsSync(path.join(paths.runtimeDir, 'native-requests.jsonl'))).toBe(true);
  });
});
