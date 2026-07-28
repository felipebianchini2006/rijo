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
import { runCli } from '../src/cli/main.js';
import { defaultExecutor } from '../src/workflows/executor.js';
import { defaultConfig } from '../src/core/config.js';
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

  it('reuses the exact pending identity when the native helper resumes', async () => {
    const root = tmpProject('rijo-native-resume-');
    roots.push(root);
    const paths = new RijoPaths(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const task = AgentTaskSchema.parse({
      id: 'plan-resume',
      role: 'planner',
      objective: 'Create the bounded phase plan.',
      canonical_files: [],
      code_files: [],
      write_scope: [],
      acceptance_criteria: ['The plan covers the phase.'],
      verification_commands: [],
      return_format: 'JSON plan payload.',
    });
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 0,
      replacement_backoff_ms: [],
    };
    const firstExecutor = defaultExecutor(new NativeResultRunner(bundle), config, paths);

    const first = await firstExecutor.run({ task, role: 'planner' });
    expect(first.ok).toBe(false);
    expect(new (await import('../src/supervisor/store.js')).TaskStore(paths).read(task.id)?.state)
      .toBe('AWAITING_NATIVE_RESULT');
    const request = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );
    fs.writeFileSync(
      bundle,
      JSON.stringify({
        version: 2,
        results: [{
          ...request,
          ok: true,
          summary: 'Created the plan.',
          payload: { phases: [] },
          files: {},
          files_written: [],
          scope_requests: [],
          decision_proposals: [],
          artifacts: [],
        }],
      }),
    );

    const resumedExecutor = defaultExecutor(new NativeResultRunner(bundle), config, paths);
    const resumed = await resumedExecutor.run({ task, role: 'planner' });

    expect(resumed.ok).toBe(true);
    expect(resumed.attempt_id).toBe(request.attempt_id);
    expect(resumed.generation).toBe(request.generation);
    expect(resumed.lease_id).toBe(request.lease_id);
    expect(new (await import('../src/supervisor/store.js')).TaskStore(paths).read(task.id)?.state)
      .toBe('SUCCEEDED');

    const replayExecutor = defaultExecutor(new NativeResultRunner(bundle), config, paths);
    const replayed = await replayExecutor.run({ task, role: 'planner' });

    expect(replayed.ok).toBe(true);
    expect(replayed.attempt_id).toBe(request.attempt_id);
    expect(replayed.generation).toBe(request.generation);
    expect(replayed.lease_id).toBe(request.lease_id);
  });

  it('fences a pending identity when task content changes before resume', async () => {
    const root = tmpProject('rijo-native-changed-resume-');
    roots.push(root);
    const paths = new RijoPaths(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const task = AgentTaskSchema.parse({
      id: 'plan-changed',
      role: 'planner',
      objective: 'Create the first bounded plan.',
      canonical_files: [],
      code_files: [],
      write_scope: [],
      acceptance_criteria: ['The plan covers the phase.'],
      verification_commands: [],
      return_format: 'JSON plan payload.',
    });
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 0,
      replacement_backoff_ms: [],
    };
    await defaultExecutor(new NativeResultRunner(bundle), config, paths).run({ task, role: 'planner' });
    const firstRequest = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );

    await defaultExecutor(new NativeResultRunner(bundle), config, paths).run({
      task: { ...task, objective: 'Create the corrected bounded plan.' },
      role: 'planner',
    });

    const requests = fs
      .readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(requests[1].request_id).not.toBe(firstRequest.request_id);
    const record = new (await import('../src/supervisor/store.js')).TaskStore(paths).read(task.id);
    expect(record?.revoked_leases).toContain(firstRequest.lease_id);
    expect(record?.lease_id).toBe(requests[1].lease_id);
  });

  it('rejects a v1 bundle in the native workflow', () => {
    const root = tmpProject('rijo-native-v1-');
    roots.push(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 1, results: [] }));
    expect(() => new NativeResultRunner(bundle)).toThrow(NativeProtocolUpgradeError);
  });

  it('archives a v1 helper bundle and regenerates an exact v2 request', async () => {
    const root = tmpProject('rijo-native-v1-upgrade-');
    roots.push(root);
    writePlanFile(root, 'PLAN.md', '# Plan\n\nCreate one local TypeScript file.\n');
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 1, results: [] }));

    await expect(
      runCli(
        ['internal', 'project-init', '@PLAN.md', '--results', '@results.json'],
        deps(root),
        root,
      ),
    ).rejects.toThrow('NATIVE_RESULT_REQUIRED');

    expect(JSON.parse(fs.readFileSync(bundle, 'utf8')).version).toBe(2);
    const archiveDir = path.join(root, '.rijo', 'runtime', 'native-v1-archive');
    const archives = fs.readdirSync(archiveDir);
    expect(archives).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(archiveDir, archives[0]!), 'utf8')).version).toBe(1);
    const request = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );
    expect(request.logical_task_id).toBe('new-extract');
    expect(request.request_id).toMatch(/^nreq_[a-f0-9]{64}$/);
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

  it('completes project setup across native helper turns without regenerating validated tasks', async () => {
    const root = tmpProject('rijo-native-project-loop-');
    roots.push(root);
    writePlanFile(root, 'PLAN.md');
    const runtime = deps(root);
    const fake = runtime.runner!;
    const bundle = path.join(root, 'native-results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    let outcome: Awaited<ReturnType<typeof newWorkflow>> | null = null;

    for (let turn = 0; turn < 8 && outcome === null; turn++) {
      try {
        outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, {
          ...runtime,
          runner: new NativeResultRunner(bundle),
        });
      } catch (error) {
        expect(String(error)).toContain('NATIVE_RESULT_REQUIRED');
        const stored = JSON.parse(fs.readFileSync(bundle, 'utf8')) as {
          version: 2;
          results: Array<{ request_id: string }>;
        };
        const completed = new Set(stored.results.map((result) => result.request_id));
        const requests = fs
          .readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        for (const request of requests) {
          if (completed.has(request.request_id)) continue;
          const task = AgentTaskSchema.parse({
            id: request.logical_task_id,
            role: request.role,
            tier: request.tier,
            objective: request.objective,
            canonical_files: request.canonical_files,
            code_files: request.code_files,
            write_scope: request.write_scope,
            acceptance_criteria: request.acceptance_criteria,
            verification_commands: request.verification_commands,
            return_format: request.return_format,
            notes: request.notes,
            expert_profiles: request.expert_profiles,
            attempt: {
              logical_task_id: request.logical_task_id,
              attempt_id: request.attempt_id,
              generation: request.generation,
              lease_id: request.lease_id,
              idempotency_key: request.idempotency_key,
              canonical_baseline_hash: null,
              workspace_id: null,
            },
          });
          const result = await fake.runTask(task);
          stored.results.push({
            ...request,
            ok: result.ok,
            summary: result.summary,
            payload: result.payload,
            files: {},
            files_written: result.files_written,
            scope_requests: result.scope_requests,
            decision_proposals: result.decision_proposals ?? [],
            artifacts: [],
          });
        }
        fs.writeFileSync(bundle, JSON.stringify(stored));
      }
    }

    expect(outcome?.ok, outcome?.message).toBe(true);
    const requests = fs
      .readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { request_id: string; logical_task_id: string });
    expect(new Set(requests.map((request) => request.request_id)).size).toBe(requests.length);
    expect(requests.map((request) => request.logical_task_id)).toEqual([
      'new-extract',
      'new-research-1',
      'new-research-2',
      'new-research-3',
      'new-roadmap',
    ]);
  });
});
