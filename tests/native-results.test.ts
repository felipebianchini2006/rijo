import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeResultRunner } from '../src/agents/native-results.js';
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

  it('exports a missing native request without starting a host process', async () => {
    const root = tmpProject('rijo-native-request-');
    roots.push(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 1, results: [] }));
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
    });

    const result = await runner.runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('no result for task plan-01');
    const request = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );
    expect(request.task_id).toBe('plan-01');
    expect(request.objective).toBe(task.objective);
  });

  it('does not create plan correction requests before the native host returns a result', async () => {
    const root = tmpProject('rijo-native-project-init-');
    roots.push(root);
    writePlanFile(root, 'PLAN.md', '# Plan\n\nCreate one local TypeScript file.\n');
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 1, results: [] }));
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
      .map((line) => JSON.parse(line) as { task_id: string });
    expect(requests.map((request) => request.task_id)).toEqual(['new-extract']);
  });

  it('applies a native writer result only inside the assigned workspace scope', async () => {
    const root = tmpProject('rijo-native-writer-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(
      bundle,
      JSON.stringify({
        version: 1,
        results: [
          {
            task_id: 'exec-01-T01',
            ok: true,
            summary: 'Implemented the bounded task.',
            payload: { done: true },
            files: { 'src/feature.ts': 'export const feature = true;\n' },
          },
        ],
      }),
    );
    const runner = new NativeResultRunner(bundle);
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
    });

    const result = await runner.runTask(task);

    expect(result.ok).toBe(true);
    expect(result.files_written).toEqual(['src/feature.ts']);
    expect(fs.readFileSync(path.join(workspace, 'src', 'feature.ts'), 'utf8')).toContain(
      'feature = true',
    );
  });

  it('keeps the phase checkpoint valid while it waits for a native result', async () => {
    const root = tmpProject('rijo-native-phase-open-');
    roots.push(root);
    writePlanFile(root, 'PLAN.md');
    const runtime = deps(root);
    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, runtime)).ok).toBe(true);
    const paths = new RijoPaths(root);
    const bundle = path.join(paths.runtimeDir, 'native-results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 1, results: [] }));

    await expect(
      startWorkflow(root, {
        ...runtime,
        runner: new NativeResultRunner(bundle),
      }),
    ).rejects.toThrow('NATIVE_RESULT_REQUIRED');

    expect(detectDrift(paths)).toEqual({ drifted: [], missing: [] });
    expect(fs.existsSync(path.join(paths.runtimeDir, 'native-requests.jsonl'))).toBe(true);
  });
});
