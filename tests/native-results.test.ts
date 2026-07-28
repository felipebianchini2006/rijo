import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeProtocolUpgradeError,
  NativeResultRunner,
  createNativeRequestV2,
} from '../src/agents/native-results.js';
import { AgentTaskSchema } from '../src/agents/protocol.js';
import { sha256 } from '../src/core/fsx.js';
import { AttemptWorkspace } from '../src/core/workspace.js';
import { detectDrift } from '../src/core/manifest.js';
import { RijoPaths } from '../src/core/paths.js';
import { readStatus } from '../src/core/progress.js';
import { readState } from '../src/core/state.js';
import { runCli } from '../src/cli/main.js';
import { defaultExecutor } from '../src/workflows/executor.js';
import { defaultConfig } from '../src/core/config.js';
import { newWorkflow } from '../src/workflows/new.js';
import { startWorkflow } from '../src/workflows/run.js';
import { TaskStore } from '../src/supervisor/store.js';
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

  const seedWorkspaceBaseline = (workspace: string): void => {
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    execFileSync('git', ['add', '-A'], { cwd: workspace });
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
    expect(request.result_contract.preserved_files).toContain('baseline SHA-256');
    expect(fs.statSync(path.join(root, 'native-dispatch')).isDirectory()).toBe(true);
    expect(request.result_contract.identity_fields).toEqual([
      'workflow_epoch',
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
    const replayRecord = new TaskStore(paths).read(task.id)!;
    expect(replayRecord.replacement_count).toBe(0);
    expect(replayRecord.revoked_leases).toEqual([]);
    expect(
      new TaskStore(paths).readEvents(task.id).filter((event) => event.type === 'task_created'),
    ).toHaveLength(1);
  });

  it('reuses a writer identity after its old workspace is discarded and writes into the fresh workspace', async () => {
    const root = tmpProject('rijo-native-writer-resume-');
    roots.push(root);
    const paths = new RijoPaths(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const workspaceA = path.join(paths.runtimeDir, 'workspaces', 'ws-writer-a');
    const workspaceB = path.join(paths.runtimeDir, 'workspaces', 'ws-writer-b');
    fs.mkdirSync(workspaceA, { recursive: true });
    seedWorkspaceBaseline(workspaceA);
    const writerTask = (workspace: string, id: string) =>
      AgentTaskSchema.parse({
        id: 'exec-01-T01',
        role: 'worker',
        objective: 'Implement the bounded feature.',
        canonical_files: [path.join(workspace, '.rijo', 'RULES.md')],
        code_files: [path.join(workspace, 'src', 'feature.ts')],
        write_scope: ['src/feature.ts'],
        acceptance_criteria: ['The feature exists.'],
        verification_commands: ['npm test'],
        return_format: 'JSON payload: {done: boolean}.',
        workspace: { id, root: workspace },
        canonical_baseline: 'baseline-01',
      });
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 0,
      replacement_backoff_ms: [],
    };

    const first = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: writerTask(workspaceA, 'ws-writer-a'), role: 'worker' });
    expect(first.ok).toBe(false);
    const requestFile = path.join(root, 'native-requests.jsonl');
    const request = JSON.parse(fs.readFileSync(requestFile, 'utf8').trim());
    expect(request.workspace_id).toBe('ws-writer-a');
    expect(request.canonical_files).toEqual([path.join(workspaceA, '.rijo', 'RULES.md')]);
    expect(request.code_files).toEqual([path.join(workspaceA, 'src', 'feature.ts')]);

    // Startup keeps the active request workspace available to the helper. Once
    // an exact result exists, replay supersedes it with a clean workspace.
    fs.mkdirSync(workspaceB, { recursive: true });
    fs.writeFileSync(
      bundle,
      JSON.stringify({
        version: 2,
        results: [{
          ...request,
          ok: true,
          summary: 'Implemented the feature.',
          payload: { done: true },
          files: { 'src/feature.ts': 'export const feature = true;\n' },
          files_written: ['src/feature.ts'],
          scope_requests: [],
          decision_proposals: [],
          artifacts: [],
        }],
      }),
    );

    const resumed = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: writerTask(workspaceB, 'ws-writer-b'), role: 'worker' });

    expect(resumed.ok).toBe(true);
    expect(resumed.attempt_id).toBe(request.attempt_id);
    expect(resumed.generation).toBe(request.generation);
    expect(resumed.lease_id).toBe(request.lease_id);
    expect(fs.readFileSync(path.join(workspaceB, 'src', 'feature.ts'), 'utf8'))
      .toBe('export const feature = true;\n');
    expect(fs.existsSync(workspaceA)).toBe(false);
    expect(fs.readFileSync(requestFile, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
  });

  it('keeps the pending workspace until an exact writer result materializes successfully', async () => {
    const root = tmpProject('rijo-native-writer-materialization-');
    roots.push(root);
    const paths = new RijoPaths(root);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const makeTask = (workspaceId: string) => {
      const workspace = path.join(paths.runtimeDir, 'workspaces', workspaceId);
      fs.mkdirSync(workspace, { recursive: true });
      seedWorkspaceBaseline(workspace);
      return AgentTaskSchema.parse({
        id: 'exec-materialization',
        role: 'worker',
        objective: 'Create one portable feature.',
        canonical_files: [],
        code_files: [path.join(workspace, 'src', 'feature.ts')],
        write_scope: ['src/feature.ts'],
        acceptance_criteria: ['The feature exists.'],
        verification_commands: [],
        return_format: 'JSON result.',
        workspace: { id: workspaceId, root: workspace },
        canonical_baseline: 'baseline-01',
      });
    };
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 0,
      replacement_backoff_ms: [],
    };
    const workspaceA = makeTask('ws-materialization-a');
    const first = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: workspaceA, role: 'worker' });
    expect(first.ok).toBe(false);
    const request = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      active_workflow_epoch: request.workflow_epoch,
      results: [{
        ...request,
        ok: true,
        summary: 'Implemented the task without portable output.',
        payload: { done: true },
      }],
    }));

    const workspaceB = makeTask('ws-materialization-b');
    const invalid = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: workspaceB, role: 'worker' });

    expect(invalid.ok).toBe(false);
    expect(invalid.summary).toContain('did not materialize any file delta');
    expect(new TaskStore(paths).read(workspaceA.id)?.state).toBe('AWAITING_NATIVE_RESULT');
    expect(new TaskStore(paths).read(workspaceA.id)?.workspace_id).toBe('ws-materialization-a');
    expect(fs.existsSync(workspaceA.workspace!.root)).toBe(true);

    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Implemented the task with portable output.',
        payload: { done: true },
        files: { 'src/feature.ts': 'export const feature = true;\n' },
        files_written: ['src/feature.ts'],
      }],
    }));
    const workspaceC = makeTask('ws-materialization-c');
    const accepted = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: workspaceC, role: 'worker' });

    expect(accepted.ok).toBe(true);
    expect(fs.existsSync(workspaceA.workspace!.root)).toBe(false);
    expect(new TaskStore(paths).read(workspaceA.id)?.workspace_id).toBe('ws-materialization-c');
    expect(fs.readFileSync(path.join(workspaceC.workspace!.root, 'src', 'feature.ts'), 'utf8'))
      .toContain('feature = true');
  });

  it('materializes a preserved delayed result into the current workspace and checkout', async () => {
    const root = tmpProject('rijo-native-preserved-replay-');
    roots.push(root);
    const paths = new RijoPaths(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const baseline = 'export const feature = false;\n';
    const changed = 'export const feature = true;\n';
    fs.writeFileSync(path.join(root, 'src', 'feature.ts'), baseline);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const makeWorkspace = () =>
      AttemptWorkspace.create(root, {
        taskId: 'exec-preserved-replay',
        writeScope: ['src/feature.ts'],
        baselineCanonicalHash: 'baseline-01',
      });
    const makeTask = (workspace: AttemptWorkspace) =>
      AgentTaskSchema.parse({
        id: 'exec-preserved-replay',
        role: 'worker',
        objective: 'Change the feature.',
        canonical_files: [],
        code_files: [path.join(workspace.root, 'src', 'feature.ts')],
        write_scope: ['src/feature.ts'],
        acceptance_criteria: ['The changed feature reaches the checkout.'],
        verification_commands: [],
        return_format: 'JSON result.',
        workspace: { id: workspace.id, root: workspace.root },
        canonical_baseline: 'baseline-01',
      });
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 0,
      replacement_backoff_ms: [],
    };
    const originalWorkspace = makeWorkspace();
    const originalTask = makeTask(originalWorkspace);
    const pending = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: originalTask, role: 'worker' });
    expect(pending.ok).toBe(false);
    const request = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );

    fs.writeFileSync(path.join(originalWorkspace.root, 'src', 'feature.ts'), changed);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Changed the feature in the original attempt workspace.',
        payload: { done: true },
        files_written: ['src/feature.ts'],
        preserved_files: [{
          target_path: 'src/feature.ts',
          sha256: sha256(changed),
          workspace_id: originalWorkspace.id,
          baseline_sha256: sha256(baseline),
        }],
      }],
    }));

    const currentWorkspace = makeWorkspace();
    const currentTask = makeTask(currentWorkspace);
    const accepted = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: currentTask, role: 'worker' });

    expect(accepted.ok, accepted.summary).toBe(true);
    expect(fs.existsSync(originalWorkspace.root)).toBe(false);
    expect(fs.readFileSync(path.join(currentWorkspace.root, 'src', 'feature.ts'), 'utf8'))
      .toBe(changed);
    expect(currentWorkspace.validate().changed).toEqual(['src/feature.ts']);
    expect(currentWorkspace.applyVerifiedPatch().applied).toEqual(['src/feature.ts']);
    expect(fs.readFileSync(path.join(root, 'src', 'feature.ts'), 'utf8')).toBe(changed);
  });

  it('fences delayed output when the checkout preimage changed after dispatch', async () => {
    const root = tmpProject('rijo-native-preimage-conflict-');
    roots.push(root);
    const paths = new RijoPaths(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const original = 'export const feature = "A";\n';
    const userEdit = 'export const feature = "B";\n';
    const delayed = 'export const feature = "C";\n';
    fs.writeFileSync(path.join(root, 'src', 'feature.ts'), original);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const makeWorkspace = () =>
      AttemptWorkspace.create(root, {
        taskId: 'exec-preimage-conflict',
        writeScope: ['src/feature.ts'],
        baselineCanonicalHash: 'baseline-01',
      });
    const makeTask = (workspace: AttemptWorkspace) =>
      AgentTaskSchema.parse({
        id: 'exec-preimage-conflict',
        role: 'worker',
        objective: 'Change the feature.',
        canonical_files: [],
        code_files: [path.join(workspace.root, 'src', 'feature.ts')],
        write_scope: ['src/feature.ts'],
        acceptance_criteria: ['The feature changes without overwriting concurrent work.'],
        verification_commands: [],
        return_format: 'JSON result.',
        workspace: { id: workspace.id, root: workspace.root },
        canonical_baseline: 'baseline-01',
      });
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 0,
      replacement_backoff_ms: [],
    };
    const originalWorkspace = makeWorkspace();
    const originalTask = makeTask(originalWorkspace);
    const pending = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: originalTask, role: 'worker' });
    expect(pending.ok).toBe(false);
    const request = JSON.parse(
      fs.readFileSync(path.join(root, 'native-requests.jsonl'), 'utf8').trim(),
    );

    fs.writeFileSync(path.join(originalWorkspace.root, 'src', 'feature.ts'), delayed);
    fs.writeFileSync(path.join(root, 'src', 'feature.ts'), userEdit);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Completed the delayed feature change.',
        payload: { done: true },
        files_written: ['src/feature.ts'],
        preserved_files: [{
          target_path: 'src/feature.ts',
          sha256: sha256(delayed),
          workspace_id: originalWorkspace.id,
          baseline_sha256: sha256(original),
        }],
      }],
    }));

    const currentWorkspace = makeWorkspace();
    const currentTask = makeTask(currentWorkspace);
    const rejected = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: currentTask, role: 'worker' });

    expect(rejected.ok).toBe(false);
    expect(rejected.summary).toContain('preimage conflict');
    expect(fs.readFileSync(path.join(currentWorkspace.root, 'src', 'feature.ts'), 'utf8'))
      .toBe(userEdit);
    expect(fs.readFileSync(path.join(root, 'src', 'feature.ts'), 'utf8')).toBe(userEdit);
    expect(fs.existsSync(originalWorkspace.root)).toBe(true);
    expect(new TaskStore(paths).read(originalTask.id)?.state).toBe('EXHAUSTED');
  });

  it('checks delayed preimages for each portable file operation', async () => {
    const cases = ['inline', 'artifact', 'delete', 'rename-source', 'rename-target'] as const;
    for (const operation of cases) {
      const root = tmpProject(`rijo-native-preimage-${operation}-`);
      roots.push(root);
      const workspaces = path.join(root, '.rijo', 'runtime', 'workspaces');
      const sourceRoot = path.join(workspaces, `ws-source-${operation}`);
      const currentRoot = path.join(workspaces, `ws-current-${operation}`);
      fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
      fs.mkdirSync(path.join(currentRoot, 'src'), { recursive: true });
      const original = 'export const feature = "A";\n';
      const userEdit = 'export const feature = "B";\n';
      const delayed = Buffer.from('export const feature = "C";\n');
      fs.writeFileSync(path.join(sourceRoot, 'src', 'feature.ts'), original);
      seedWorkspaceBaseline(sourceRoot);
      fs.writeFileSync(
        path.join(currentRoot, 'src', 'feature.ts'),
        operation === 'rename-target' ? original : userEdit,
      );
      if (operation === 'rename-target') {
        fs.writeFileSync(path.join(currentRoot, 'src', 'renamed.ts'), userEdit);
      }
      const logicalTaskId = `exec-preimage-${operation}`;
      const makeTask = (
        workspace: { id: string; root: string; replay_source?: { id: string; root: string } },
        workspaceId: string,
      ) =>
        AgentTaskSchema.parse({
          id: logicalTaskId,
          role: 'worker',
          objective: 'Apply one delayed portable operation.',
          canonical_files: [],
          code_files: [path.join(workspace.root, 'src', 'feature.ts')],
          write_scope: ['src/feature.ts', 'src/renamed.ts'],
          acceptance_criteria: ['Concurrent edits remain intact.'],
          verification_commands: [],
          return_format: 'JSON result.',
          workspace,
          canonical_baseline: 'baseline-01',
          attempt: {
            ...attempt,
            logical_task_id: logicalTaskId,
            workspace_id: workspaceId,
          },
        });
      const originalTask = makeTask(
        { id: `ws-source-${operation}`, root: sourceRoot },
        `ws-source-${operation}`,
      );
      const request = createNativeRequestV2(originalTask);
      const resultEntry: Record<string, unknown> = {
        ...request,
        ok: true,
        summary: 'Completed one delayed operation.',
        payload: { done: true },
      };
      if (operation === 'inline') {
        resultEntry.files = { 'src/feature.ts': delayed.toString('utf8') };
        resultEntry.files_written = ['src/feature.ts'];
      } else if (operation === 'artifact') {
        const staging = path.join(root, 'staging');
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(path.join(staging, 'feature.ts'), delayed);
        resultEntry.files_written = ['src/feature.ts'];
        resultEntry.artifacts = [{
          target_path: 'src/feature.ts',
          staged_path: 'staging/feature.ts',
          sha256: sha256(delayed),
          size: delayed.length,
          media_type: 'text/plain',
        }];
      } else if (operation === 'delete') {
        resultEntry.files_written = ['src/feature.ts'];
        resultEntry.deleted_paths = [{ path: 'src/feature.ts', sha256: sha256(original) }];
      } else {
        resultEntry.files_written = ['src/feature.ts', 'src/renamed.ts'];
        resultEntry.renames = [{
          source_path: 'src/feature.ts',
          target_path: 'src/renamed.ts',
          source_sha256: sha256(original),
        }];
      }
      const bundle = path.join(root, 'results.json');
      fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [resultEntry] }));
      const currentTask = makeTask(
        {
          id: `ws-current-${operation}`,
          root: currentRoot,
          replay_source: { id: `ws-source-${operation}`, root: sourceRoot },
        },
        `ws-current-${operation}`,
      );

      const result = await new NativeResultRunner(bundle).runTask(currentTask);

      expect(result.ok, operation).toBe(false);
      expect(result.summary, operation).toContain('preimage conflict');
      expect(fs.readFileSync(path.join(currentRoot, 'src', 'feature.ts'), 'utf8'))
        .toBe(operation === 'rename-target' ? original : userEdit);
      if (operation === 'rename-target') {
        expect(fs.readFileSync(path.join(currentRoot, 'src', 'renamed.ts'), 'utf8')).toBe(userEdit);
      } else {
        expect(fs.existsSync(path.join(currentRoot, 'src', 'renamed.ts'))).toBe(false);
      }
    }
  });

  it('replaces a fenced delayed result once and retains the winning workspace', async () => {
    const root = tmpProject('rijo-native-preimage-replacement-');
    roots.push(root);
    const paths = new RijoPaths(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const original = 'export const feature = "A";\n';
    const userEdit = 'export const feature = "B";\n';
    const delayed = 'export const feature = "C";\n';
    fs.writeFileSync(path.join(root, 'src', 'feature.ts'), original);
    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const makeWorkspace = () =>
      AttemptWorkspace.create(root, {
        taskId: 'exec-preimage-replacement',
        writeScope: ['src/feature.ts'],
        baselineCanonicalHash: 'baseline-01',
      });
    const makeTask = (workspace: AttemptWorkspace) =>
      AgentTaskSchema.parse({
        id: 'exec-preimage-replacement',
        role: 'worker',
        objective: 'Change the feature.',
        canonical_files: [],
        code_files: [path.join(workspace.root, 'src', 'feature.ts')],
        write_scope: ['src/feature.ts'],
        acceptance_criteria: ['The latest generation changes the feature.'],
        verification_commands: [],
        return_format: 'JSON result.',
        workspace: { id: workspace.id, root: workspace.root },
        canonical_baseline: 'baseline-01',
      });
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 2,
      replacement_backoff_ms: [],
    };
    const generation1Workspace = makeWorkspace();
    const generation1Task = makeTask(generation1Workspace);
    const generation1Pending = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: generation1Task, role: 'worker' });
    expect(generation1Pending.ok).toBe(false);
    const requestFile = path.join(root, 'native-requests.jsonl');
    const generation1Request = JSON.parse(fs.readFileSync(requestFile, 'utf8').trim());

    fs.writeFileSync(path.join(generation1Workspace.root, 'src', 'feature.ts'), delayed);
    fs.writeFileSync(path.join(root, 'src', 'feature.ts'), userEdit);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      active_workflow_epoch: generation1Request.workflow_epoch,
      results: [{
        ...generation1Request,
        ok: true,
        summary: 'Completed the stale generation.',
        payload: { done: true },
        files_written: ['src/feature.ts'],
        preserved_files: [{
          target_path: 'src/feature.ts',
          sha256: sha256(delayed),
          workspace_id: generation1Workspace.id,
          baseline_sha256: sha256(original),
        }],
      }],
    }));

    const replayWorkspace = makeWorkspace();
    const replayTask = makeTask(replayWorkspace);
    let generation2Workspace: AttemptWorkspace | null = null;
    const generation2Pending = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({
      task: replayTask,
      role: 'worker',
      prepareReplacement: () => {
        replayWorkspace.discard();
        generation2Workspace = makeWorkspace();
        const prepared = generation2Workspace;
        return {
          task: makeTask(prepared),
          dispose: () => prepared.discard(),
        };
      },
    });

    expect(generation2Pending.ok).toBe(false);
    expect(generation2Pending.summary).toContain('no exact native identity');
    expect(generation2Workspace).not.toBeNull();
    const generation2 = generation2Workspace!;
    const requests = fs.readFileSync(requestFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(requests[1].generation).toBe(generation1Request.generation + 1);
    expect(requests[1].lease_id).not.toBe(generation1Request.lease_id);
    let record = new TaskStore(paths).read(generation1Task.id)!;
    expect(record.state).toBe('AWAITING_NATIVE_RESULT');
    expect(record.generation).toBe(2);
    expect(record.revoked_leases).toContain(generation1Request.lease_id);
    expect(record.workspace_id).toBe(generation2.id);
    expect(fs.existsSync(generation1Workspace.root)).toBe(false);
    expect(fs.existsSync(generation2.root)).toBe(true);

    fs.writeFileSync(path.join(generation2.root, 'src', 'feature.ts'), delayed);
    const stored = JSON.parse(fs.readFileSync(bundle, 'utf8')) as {
      version: 2;
      results: Array<Record<string, unknown>>;
    };
    stored.results.push({
      ...requests[1],
      ok: true,
      summary: 'Completed the replacement generation.',
      payload: { done: true },
      files_written: ['src/feature.ts'],
      preserved_files: [{
        target_path: 'src/feature.ts',
        sha256: sha256(delayed),
        workspace_id: generation2.id,
        baseline_sha256: sha256(userEdit),
      }],
    });
    fs.writeFileSync(bundle, JSON.stringify(stored));

    const winningWorkspace = makeWorkspace();
    const winningTask = makeTask(winningWorkspace);
    const accepted = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: winningTask, role: 'worker' });

    expect(accepted.ok, accepted.summary).toBe(true);
    record = new TaskStore(paths).read(generation1Task.id)!;
    expect(record.state).toBe('SUCCEEDED');
    expect(record.generation).toBe(2);
    expect(record.replacement_count).toBe(1);
    expect(record.revoked_leases).toContain(generation1Request.lease_id);
    expect(fs.existsSync(generation2.root)).toBe(false);
    expect(fs.existsSync(winningWorkspace.root)).toBe(true);
    expect(winningWorkspace.validate().changed).toEqual(['src/feature.ts']);
    expect(winningWorkspace.applyVerifiedPatch().applied).toEqual(['src/feature.ts']);
    expect(fs.readFileSync(path.join(root, 'src', 'feature.ts'), 'utf8')).toBe(delayed);
    expect(fs.readFileSync(requestFile, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
  });

  it('replaces a native writer result rejected by deterministic validation with a new fenced identity', async () => {
    const root = tmpProject('rijo-native-validation-replacement-');
    roots.push(root);
    const paths = new RijoPaths(root);
    const bundle = path.join(root, 'results.json');
    const requestFile = path.join(root, 'native-requests.jsonl');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const config = {
      ...defaultConfig().supervisor,
      max_replacements_per_task: 0,
      replacement_backoff_ms: [],
    };
    const makeTask = (workspaceId: string, notes = '') => {
      const workspace = path.join(paths.runtimeDir, 'workspaces', workspaceId);
      fs.mkdirSync(workspace, { recursive: true });
      return AgentTaskSchema.parse({
        id: 'exec-01-T03',
        role: 'worker',
        objective: 'Implement the tested behavior.',
        canonical_files: [path.join(workspace, '.rijo', 'RULES.md')],
        code_files: [
          path.join(workspace, 'src', 'feature.ts'),
          path.join(workspace, 'test', 'feature.test.ts'),
        ],
        write_scope: ['src/feature.ts', 'test/feature.test.ts'],
        acceptance_criteria: ['The test proves the behavior.'],
        verification_commands: ['node --test test/feature.test.ts'],
        return_format: 'JSON payload: {done: boolean}.',
        notes,
        workspace: { id: workspaceId, root: workspace },
        canonical_baseline: 'baseline-01',
      });
    };

    const firstTask = makeTask('ws-native-validation-g1');
    const firstPending = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: firstTask, role: 'worker' });
    expect(firstPending.ok).toBe(false);
    const firstRequest = JSON.parse(fs.readFileSync(requestFile, 'utf8').trim());
    fs.writeFileSync(
      bundle,
      JSON.stringify({
        version: 2,
        results: [{
          ...firstRequest,
          ok: true,
          summary: 'Implemented the first result.',
          payload: { done: true },
          files: {
            'src/feature.ts': 'export const feature = true;\n',
            'test/feature.test.ts': "import '../src/missing.ts';\n",
          },
          files_written: ['src/feature.ts', 'test/feature.test.ts'],
          scope_requests: [],
          decision_proposals: [],
          artifacts: [],
        }],
      }),
    );
    const accepted = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: firstTask, role: 'worker' });
    expect(accepted.ok).toBe(true);

    const correctionReason =
      'The RED command failed because the test environment was incomplete: ENOENT missing test module.';
    const replacementTask = makeTask(
      'ws-native-validation-g2',
      `The prior result failed deterministic TDD RED validation. ${correctionReason}`,
    );
    const replacementPending = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({
      task: replacementTask,
      role: 'worker',
      replaceAfterValidationFailure: {
        reason: correctionReason,
        maxReplacements: 2,
      },
    });

    expect(replacementPending.ok).toBe(false);
    expect(replacementPending.summary).toContain('no result for task exec-01-T03');
    const requests = fs
      .readFileSync(requestFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(requests[1].generation).toBe(firstRequest.generation + 1);
    expect(requests[1].attempt_id).not.toBe(firstRequest.attempt_id);
    expect(requests[1].lease_id).not.toBe(firstRequest.lease_id);
    expect(requests[1].request_id).not.toBe(firstRequest.request_id);
    expect(requests[1].canonical_files[0]).toContain('ws-native-validation-g2');
    expect(requests[1].code_files[0]).toContain('ws-native-validation-g2');
    const record = new TaskStore(paths).read(firstTask.id);
    expect(record?.state).toBe('AWAITING_NATIVE_RESULT');
    expect(record?.generation).toBe(2);
    expect(record?.replacement_count).toBe(1);
    expect(record?.revoked_leases).toContain(firstRequest.lease_id);

    const secondRequest = requests[1]!;
    const stored = JSON.parse(fs.readFileSync(bundle, 'utf8')) as {
      version: 2;
      results: Array<Record<string, unknown>>;
    };
    stored.results.push({
      ...secondRequest,
      ok: true,
      summary: 'Implemented the corrected result.',
      payload: { done: true },
      files: {
        'src/feature.ts': 'export const feature = true;\n',
        'test/feature.test.ts': "throw new Error('expected RED');\n",
      },
      files_written: ['src/feature.ts', 'test/feature.test.ts'],
      scope_requests: [],
      decision_proposals: [],
      artifacts: [],
    });
    fs.writeFileSync(bundle, JSON.stringify(stored));
    fs.rmSync(replacementTask.workspace!.root, { recursive: true, force: true });
    const resumedTask = makeTask(
      'ws-native-validation-g2-resumed',
      `The prior result failed deterministic TDD RED validation. ${correctionReason}`,
    );
    const resumed = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({ task: resumedTask, role: 'worker' });

    expect(resumed.ok).toBe(true);
    expect(resumed.generation).toBe(2);
    expect(resumed.attempt_id).toBe(secondRequest.attempt_id);
    expect(resumed.lease_id).toBe(secondRequest.lease_id);
    expect(
      fs.readFileSync(
        path.join(resumedTask.workspace!.root, 'test', 'feature.test.ts'),
        'utf8',
      ),
    ).toContain('expected RED');
    expect(fs.readFileSync(requestFile, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
    const resumedRecord = new TaskStore(paths).read(firstTask.id)!;
    expect(resumedRecord.generation).toBe(2);
    expect(resumedRecord.replacement_count).toBe(1);
    expect(resumedRecord.revoked_leases).toContain(firstRequest.lease_id);
    expect(
      new TaskStore(paths).readEvents(firstTask.id).filter((event) => event.type === 'task_created'),
    ).toHaveLength(1);

    const exhausted = await defaultExecutor(
      new NativeResultRunner(bundle),
      config,
      paths,
    ).run({
      task: makeTask(
        'ws-native-validation-exhausted',
        'The corrected result still has no valid RED evidence.',
      ),
      role: 'worker',
      replaceAfterValidationFailure: {
        reason: 'The corrected result still has no valid RED evidence.',
        maxReplacements: 1,
      },
    });
    expect(exhausted.ok).toBe(false);
    expect(exhausted.summary).toContain('validation replacement budget');
    expect(new TaskStore(paths).read(firstTask.id)?.state).toBe('EXHAUSTED');
    expect(fs.readFileSync(requestFile, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
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
    expect(record?.generation).toBe(firstRequest.generation + 1);
    expect(record?.replacement_count).toBe(0);
    expect(
      new TaskStore(paths).readEvents(task.id).filter((event) => event.type === 'task_created'),
    ).toHaveLength(1);
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
    expect(
      await runCli(
        ['internal', 'workflow-open', 'new', '@PLAN.md'],
        deps(root),
        root,
      ),
    ).toBe(0);

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

  it('uses the configured replacement budget through the internal native helper', async () => {
    const root = tmpProject('rijo-native-helper-budget-');
    roots.push(root);
    writePlanFile(root, 'PLAN.md');
    const runtime = deps(root);
    const paths = new RijoPaths(root);
    fs.mkdirSync(paths.runtimeDir, { recursive: true });
    const bundle = path.join(paths.runtimeDir, 'native-results.json');
    const requestFile = path.join(paths.runtimeDir, 'native-requests.jsonl');
    fs.writeFileSync(bundle, JSON.stringify({ version: 2, results: [] }));
    const helperArgs = [
      'internal',
      'project-init',
      '@PLAN.md',
      '--results',
      '@.rijo/runtime/native-results.json',
    ];
    expect(
      await runCli(
        ['internal', 'workflow-open', 'new', '@PLAN.md'],
        runtime,
        root,
      ),
    ).toBe(0);

    await expect(runCli(helperArgs, runtime, root)).rejects.toThrow('NATIVE_RESULT_REQUIRED');
    const generation1Request = JSON.parse(fs.readFileSync(requestFile, 'utf8').trim());
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      active_workflow_epoch: generation1Request.workflow_epoch,
      results: [{
        ...generation1Request,
        ok: false,
        summary: 'Native delayed result preimage conflict at PLAN.md.',
        payload: null,
      }],
    }));

    await expect(runCli(helperArgs, runtime, root)).rejects.toThrow('NATIVE_RESULT_REQUIRED');
    const requestsAfterFence = fs.readFileSync(requestFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(
      new Set(
        requestsAfterFence.map((request) => request.workflow_epoch),
      ),
    ).toEqual(new Set([generation1Request.workflow_epoch]));
    const generation2Request = requestsAfterFence.find(
      (request) => request.logical_task_id === 'new-extract' && request.generation === 2,
    );
    expect(generation2Request).toBeDefined();
    expect(generation2Request.lease_id).not.toBe(generation1Request.lease_id);
    let record = new TaskStore(paths).read('new-extract')!;
    expect(record.state).toBe('AWAITING_NATIVE_RESULT');
    expect(record.generation).toBe(2);
    expect(record.revoked_leases).toContain(generation1Request.lease_id);
    expect(record.replacement_count).toBe(1);

    const generation2Task = AgentTaskSchema.parse({
      id: generation2Request.logical_task_id,
      role: generation2Request.role,
      tier: generation2Request.tier,
      objective: generation2Request.objective,
      canonical_files: generation2Request.canonical_files,
      code_files: generation2Request.code_files,
      write_scope: generation2Request.write_scope,
      acceptance_criteria: generation2Request.acceptance_criteria,
      verification_commands: generation2Request.verification_commands,
      return_format: generation2Request.return_format,
      notes: generation2Request.notes,
      expert_profiles: generation2Request.expert_profiles,
      attempt: {
        logical_task_id: generation2Request.logical_task_id,
        attempt_id: generation2Request.attempt_id,
        generation: generation2Request.generation,
        lease_id: generation2Request.lease_id,
        idempotency_key: generation2Request.idempotency_key,
        canonical_baseline_hash: null,
        workspace_id: null,
      },
    });
    const generation2Result = await runtime.runner.runTask(generation2Task);
    const stored = JSON.parse(fs.readFileSync(bundle, 'utf8')) as {
      version: 2;
      results: Array<Record<string, unknown>>;
    };
    stored.results.push({
      ...generation2Request,
      ok: generation2Result.ok,
      summary: generation2Result.summary,
      payload: generation2Result.payload,
      files: {},
      files_written: generation2Result.files_written,
      scope_requests: generation2Result.scope_requests,
      decision_proposals: generation2Result.decision_proposals ?? [],
      artifacts: [],
    });
    fs.writeFileSync(bundle, JSON.stringify(stored));

    await expect(runCli(helperArgs, runtime, root)).rejects.toThrow('NATIVE_RESULT_REQUIRED');
    record = new TaskStore(paths).read('new-extract')!;
    expect(record.state).toBe('SUCCEEDED');
    expect(record.generation).toBe(2);
    expect(record.replacement_count).toBe(1);
    expect(
      fs.readFileSync(requestFile, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
        .filter((request) => request.logical_task_id === 'new-extract'),
    ).toHaveLength(2);
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

  it('rejects a declared write when the result does not provide portable bytes', async () => {
    const root = tmpProject('rijo-native-missing-bytes-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'exec-missing-bytes',
      role: 'worker',
      objective: 'Create one portable file.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/feature.ts'],
      acceptance_criteria: ['The file exists.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: { ...attempt, logical_task_id: 'exec-missing-bytes' },
    });
    const request = createNativeRequestV2(task);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Created the file.',
        payload: { done: true },
        files_written: ['src/feature.ts'],
      }],
    }));

    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('without inline bytes');
    expect(fs.existsSync(path.join(workspace, 'src', 'feature.ts'))).toBe(false);
  });

  it('rejects a successful writer result with an empty materialized payload', async () => {
    const root = tmpProject('rijo-native-empty-writer-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'exec-empty-writer',
      role: 'worker',
      objective: 'Create one file.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/feature.ts'],
      acceptance_criteria: ['The file exists.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: {
        ...attempt,
        logical_task_id: 'exec-empty-writer',
        workspace_id: 'native-workspace',
      },
    });
    const request = createNativeRequestV2(task);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Implemented the task.',
        payload: { done: true },
      }],
    }));

    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('did not materialize any file delta');
  });

  it('rejects a declared inline write when it produces an empty delta', async () => {
    const root = tmpProject('rijo-native-empty-delta-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'feature.ts'), 'export const feature = true;\n');
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'exec-empty-delta',
      role: 'worker',
      objective: 'Change the feature.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/feature.ts'],
      acceptance_criteria: ['The feature changes.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: { ...attempt, logical_task_id: 'exec-empty-delta' },
    });
    const request = createNativeRequestV2(task);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Changed the feature.',
        payload: { done: true },
        files: { 'src/feature.ts': 'export const feature = true;\n' },
        files_written: ['src/feature.ts'],
      }],
    }));

    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('without a materialized delta');
  });

  it('rejects a preserved workspace file that has no baseline delta', async () => {
    const root = tmpProject('rijo-native-preserved-file-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const content = 'export const feature = true;\n';
    fs.writeFileSync(path.join(workspace, 'src', 'feature.ts'), content);
    seedWorkspaceBaseline(workspace);
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'exec-preserved-file',
      role: 'worker',
      objective: 'Return the verified workspace file.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/feature.ts'],
      acceptance_criteria: ['The exact file is present.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: {
        ...attempt,
        logical_task_id: 'exec-preserved-file',
        workspace_id: 'native-workspace',
      },
    });
    const request = createNativeRequestV2(task);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Verified the preserved file.',
        payload: { done: true },
        files_written: ['src/feature.ts'],
        preserved_files: [{
          target_path: 'src/feature.ts',
          sha256: sha256(content),
          workspace_id: 'native-workspace',
          baseline_sha256: sha256(content),
        }],
      }],
    }));

    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('has no delta from its attempt baseline');
  });

  it('accepts a preserved file changed in the exact attempt workspace', async () => {
    const root = tmpProject('rijo-native-preserved-delta-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const baseline = 'export const feature = false;\n';
    const changed = 'export const feature = true;\n';
    fs.writeFileSync(path.join(workspace, 'src', 'feature.ts'), baseline);
    seedWorkspaceBaseline(workspace);
    fs.writeFileSync(path.join(workspace, 'src', 'feature.ts'), changed);
    const bundle = path.join(root, 'results.json');
    const task = AgentTaskSchema.parse({
      id: 'exec-preserved-delta',
      role: 'worker',
      objective: 'Return the changed workspace file.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/feature.ts'],
      acceptance_criteria: ['The changed file is present.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: {
        ...attempt,
        logical_task_id: 'exec-preserved-delta',
        workspace_id: 'native-workspace',
      },
    });
    const request = createNativeRequestV2(task);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Verified the changed workspace file.',
        payload: { done: true },
        files_written: ['src/feature.ts'],
        preserved_files: [{
          target_path: 'src/feature.ts',
          sha256: sha256(changed),
          workspace_id: 'native-workspace',
          baseline_sha256: sha256(baseline),
        }],
      }],
    }));

    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok, result.summary).toBe(true);
    expect(result.files_written).toEqual(['src/feature.ts']);
  });

  it('replays a hash-protected deletion across a native helper boundary', async () => {
    const root = tmpProject('rijo-native-delete-');
    roots.push(root);
    const bundle = path.join(root, 'results.json');
    const content = 'obsolete\n';
    const makeTask = (workspaceName: string) => {
      const workspace = path.join(root, workspaceName);
      fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'src', 'obsolete.ts'), content);
      return AgentTaskSchema.parse({
        id: 'exec-delete',
        role: 'worker',
        objective: 'Delete the obsolete file.',
        canonical_files: [],
        code_files: [],
        write_scope: ['src/obsolete.ts'],
        acceptance_criteria: ['The obsolete file is absent.'],
        verification_commands: [],
        return_format: 'JSON result.',
        workspace: { id: workspaceName, root: workspace },
        attempt: { ...attempt, logical_task_id: 'exec-delete' },
      });
    };
    const firstTask = makeTask('workspace-a');
    const request = createNativeRequestV2(firstTask);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Deleted the obsolete file.',
        payload: { done: true },
        files_written: ['src/obsolete.ts'],
        deleted_paths: [{ path: 'src/obsolete.ts', sha256: sha256(content) }],
      }],
    }));

    const first = await new NativeResultRunner(bundle).runTask(firstTask);
    const resumedTask = makeTask('workspace-b');
    const resumed = await new NativeResultRunner(bundle).runTask(resumedTask);

    expect(first.ok).toBe(true);
    expect(resumed.ok).toBe(true);
    expect(fs.existsSync(path.join(firstTask.workspace!.root, 'src', 'obsolete.ts'))).toBe(false);
    expect(fs.existsSync(path.join(resumedTask.workspace!.root, 'src', 'obsolete.ts'))).toBe(false);
  });

  it('replays a hash-protected rename across a native helper boundary', async () => {
    const root = tmpProject('rijo-native-rename-');
    roots.push(root);
    const bundle = path.join(root, 'results.json');
    const content = 'export const value = 1;\n';
    const makeTask = (workspaceName: string) => {
      const workspace = path.join(root, workspaceName);
      fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'src', 'old.ts'), content);
      return AgentTaskSchema.parse({
        id: 'exec-rename',
        role: 'worker',
        objective: 'Rename the source file.',
        canonical_files: [],
        code_files: [],
        write_scope: ['src/old.ts', 'src/new.ts'],
        acceptance_criteria: ['The new path contains the exact source.'],
        verification_commands: [],
        return_format: 'JSON result.',
        workspace: { id: workspaceName, root: workspace },
        attempt: { ...attempt, logical_task_id: 'exec-rename' },
      });
    };
    const firstTask = makeTask('workspace-a');
    const request = createNativeRequestV2(firstTask);
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Renamed the source file.',
        payload: { done: true },
        files_written: ['src/old.ts', 'src/new.ts'],
        renames: [{
          source_path: 'src/old.ts',
          target_path: 'src/new.ts',
          source_sha256: sha256(content),
        }],
      }],
    }));

    const first = await new NativeResultRunner(bundle).runTask(firstTask);
    const resumedTask = makeTask('workspace-b');
    const resumed = await new NativeResultRunner(bundle).runTask(resumedTask);

    expect(first.ok).toBe(true);
    expect(resumed.ok).toBe(true);
    expect(fs.existsSync(path.join(resumedTask.workspace!.root, 'src', 'old.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(resumedTask.workspace!.root, 'src', 'new.ts'), 'utf8')).toBe(content);
  });

  it('rejects path escape and write-scope violations for portable operations', async () => {
    const root = tmpProject('rijo-native-operation-scope-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const content = 'obsolete\n';
    fs.writeFileSync(path.join(workspace, 'src', 'obsolete.ts'), content);
    const task = AgentTaskSchema.parse({
      id: 'exec-operation-scope',
      role: 'worker',
      objective: 'Delete one assigned file.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/allowed.ts'],
      acceptance_criteria: ['Only the assigned path changes.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: { ...attempt, logical_task_id: 'exec-operation-scope' },
    });
    const request = createNativeRequestV2(task);
    const escaped = path.join(root, 'escaped.json');
    fs.writeFileSync(escaped, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Deleted a file.',
        files_written: ['../outside.ts'],
        deleted_paths: [{ path: '../outside.ts', sha256: sha256(content) }],
      }],
    }));
    expect(() => new NativeResultRunner(escaped)).toThrow(
      'Native result paths must be normalized project-relative POSIX paths',
    );

    const bundle = path.join(root, 'results.json');
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...request,
        ok: true,
        summary: 'Deleted a file.',
        files_written: ['src/obsolete.ts'],
        deleted_paths: [{ path: 'src/obsolete.ts', sha256: sha256(content) }],
      }],
    }));
    const result = await new NativeResultRunner(bundle).runTask(task);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('outside the task write scope');
    expect(fs.existsSync(path.join(workspace, 'src', 'obsolete.ts'))).toBe(true);
  });

  it('does not apply a stale deletion result to the current attempt workspace', async () => {
    const root = tmpProject('rijo-native-stale-delete-');
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    const content = 'keep\n';
    fs.writeFileSync(path.join(workspace, 'src', 'keep.ts'), content);
    const bundle = path.join(root, 'results.json');
    const currentTask = AgentTaskSchema.parse({
      id: 'exec-stale-delete',
      role: 'worker',
      objective: 'Delete the assigned file.',
      canonical_files: [],
      code_files: [],
      write_scope: ['src/keep.ts'],
      acceptance_criteria: ['The file is absent.'],
      verification_commands: [],
      return_format: 'JSON result.',
      workspace: { id: 'native-workspace', root: workspace },
      attempt: {
        ...attempt,
        logical_task_id: 'exec-stale-delete',
        generation: 2,
        attempt_id: 'attempt-02',
        lease_id: 'lease-02',
      },
    });
    const staleRequest = createNativeRequestV2({
      ...currentTask,
      attempt: {
        ...currentTask.attempt!,
        generation: 1,
        attempt_id: 'attempt-01',
        lease_id: 'lease-01',
      },
    });
    fs.writeFileSync(bundle, JSON.stringify({
      version: 2,
      results: [{
        ...staleRequest,
        ok: true,
        summary: 'Deleted the file.',
        files_written: ['src/keep.ts'],
        deleted_paths: [{ path: 'src/keep.ts', sha256: sha256(content) }],
      }],
    }));

    const result = await new NativeResultRunner(bundle).runTask(currentTask);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('no exact native identity');
    expect(fs.readFileSync(path.join(workspace, 'src', 'keep.ts'), 'utf8')).toBe(content);
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
    expect(readState(paths)?.phase).toBeNull();
    expect(readStatus(paths)?.phase?.id).toBe('01');
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
