import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RijoPaths } from '../src/core/paths.js';
import { SystemGit } from '../src/core/git.js';
import { mapWorkflow, queryCodebaseMap, readCodebaseMapStatus } from '../src/workflows/map.js';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { collectGitHistory, sameFilesystemPath } from '../src/codebase/git.js';
import { buildInventory } from '../src/codebase/inventory.js';
import { runBaseline } from '../src/codebase/baseline.js';
import { createContext } from '../src/workflows/shared.js';
import { FakeShellRunner, type ShellRunner } from '../src/core/commands.js';
import { SupervisorConfigSchema } from '../src/core/schemas/index.js';
import { cleanup, deps, mapFragmentFor, tmpProject, writePlanFile } from './helpers.js';
import { readStaleMarker } from '../src/codebase/state.js';
import { initialState, writeState } from '../src/core/state.js';
import { defaultConfig, saveConfig } from '../src/core/config.js';

const ARTIFACTS = [
  'SUMMARY.md',
  'STACK.md',
  'ARCHITECTURE.md',
  'STRUCTURE.md',
  'MODULES.md',
  'CONVENTIONS.md',
  'TESTING.md',
  'APIS.md',
  'DATA.md',
  'INTEGRATIONS.md',
  'OPERATIONS.md',
  'HISTORY.md',
  'CONCERNS.md',
  'BASELINE.md',
  'inventory.json',
  'symbols.json',
  'dependency-graph.json',
  'surfaces.json',
  'baseline.json',
  'review-receipts.json',
  'map-state.json',
];

it('compares Windows real paths with case-insensitive filesystem semantics', () => {
  expect(
    sameFilesystemPath(
      'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\project',
      '\\\\?\\C:\\Users\\RUNNERADMIN\\AppData\\Local\\Temp\\project\\',
      true,
    ),
  ).toBe(true);
  expect(sameFilesystemPath('/tmp/Project', '/tmp/project', false)).toBe(false);
});

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=RIJO Test', '-c', 'user.email=rijo@test.local', ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function seedBrownfield(root: string): void {
  fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'brownfield',
      scripts: { typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc' },
      dependencies: { zod: '^3.25.0' },
    }),
  );
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "export { validateSession } from './auth/service.js';\n");
  fs.writeFileSync(path.join(root, 'src', 'auth', 'service.ts'), 'export function validateSession() { return true; }\n');
  fs.writeFileSync(path.join(root, 'tests', 'auth.test.ts'), 'it("validates", () => {});\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Brownfield\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'feat: initial brownfield architecture']);
}

describe('rijo map workflow', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject('rijo-map-workflow-');
    seedBrownfield(root);
  });

  afterEach(() => cleanup(root));

  it('creates a complete evidence-backed map, records a real baseline, and preserves source bytes', async () => {
    const before = fs.readFileSync(path.join(root, 'src', 'auth', 'service.ts'), 'utf8');
    const d = deps(root);
    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });
    expect(outcome.ok, `${outcome.message}\n${outcome.details?.join('\n')}`).toBe(true);

    const paths = new RijoPaths(root);
    for (const artifact of ARTIFACTS) {
      expect(fs.existsSync(path.join(paths.codebaseDir, artifact)), artifact).toBe(true);
    }
    const state = JSON.parse(fs.readFileSync(paths.codebaseMapState, 'utf8'));
    expect(state.status).toBe('COMPLETE');
    expect(state.coverage.claims_verified).toBe(1);
    expect(state.module_ids.length).toBeGreaterThan(0);
    const baseline = JSON.parse(fs.readFileSync(path.join(paths.codebaseDir, 'baseline.json'), 'utf8'));
    expect(baseline.commands.every((c: any) => c.status === 'PASSED')).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src', 'auth', 'service.ts'), 'utf8')).toBe(before);
    const reviewer = d.runner.executed.find((task) => task.id.startsWith('map-review'))!;
    expect(reviewer.objective).toContain('Do not execute repository commands');
    expect(reviewer.return_format).toContain('Evidence must be structured objects');
  });

  it('treats an unchanged valid PARTIAL map as fresh instead of repeatedly remapping it', async () => {
    const first = await mapWorkflow(root, { full: true }, { ...deps(root), git: new SystemGit() });
    expect(first.ok).toBe(true);
    const paths = new RijoPaths(root);
    const state = JSON.parse(fs.readFileSync(paths.codebaseMapState, 'utf8'));
    state.status = 'PARTIAL';
    fs.writeFileSync(paths.codebaseMapState, `${JSON.stringify(state, null, 2)}\n`);
    git(root, ['add', '.rijo/codebase/map-state.json']);
    git(root, ['commit', '-m', 'test: retain valid partial map state']);
    const d = deps(root);
    const second = await mapWorkflow(root, {}, { ...d, git: new SystemGit() });
    expect(second.ok).toBe(true);
    expect(second.message).toContain('fresh');
    expect(d.runner.executed).toHaveLength(0);
  });

  it('reviews every claim beyond 250 in bounded shards and persists structural and semantic receipts', async () => {
    for (let index = 0; index < 130; index++) {
      const dir = path.join(root, 'packages', `module-${String(index).padStart(3, '0')}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.ts'), `export const value${index} = ${index};\n`);
    }
    git(root, ['add', 'packages']);
    git(root, ['commit', '-m', 'feat: add large modular codebase']);
    const d = deps(root);
    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });
    expect(outcome.ok, outcome.message).toBe(true);

    const claims = JSON.parse(
      fs.readFileSync(path.join(new RijoPaths(root).codebaseDir, 'claims.json'), 'utf8'),
    ).claims as Array<{ statement: string }>;
    expect(claims.length).toBeGreaterThan(250);
    const reviewedStatements = new Set<string>();
    for (const task of d.runner.executed.filter((candidate) => candidate.id.startsWith('map-review-'))) {
      const marker = 'CANDIDATE CLAIM SHARD:\n';
      if (!task.notes.includes(marker)) continue;
      const raw = task.notes
        .slice(task.notes.indexOf(marker) + marker.length)
        .split('\n\nAUTONOMOUS DECISION POLICY')[0]!;
      for (const claim of JSON.parse(raw) as Array<{ statement: string }>) reviewedStatements.add(claim.statement);
    }
    expect(reviewedStatements.size).toBe(claims.length);

    const receipts = JSON.parse(
      fs.readFileSync(path.join(new RijoPaths(root).codebaseDir, 'review-receipts.json'), 'utf8'),
    );
    expect(receipts.claim_receipts).toHaveLength(claims.length);
    expect(receipts.claim_receipts.every((receipt: any) => receipt.structural_status === 'PASSED')).toBe(true);
    expect(receipts.claim_receipts.every((receipt: any) => receipt.semantic_status === 'APPROVED')).toBe(true);
    expect(receipts.claim_receipts.every((receipt: any) => receipt.final_disposition === 'APPROVED')).toBe(true);
    expect(receipts.consolidation.status).toBe('APPROVED');
  }, 120_000);

  it('rejects an unapproved candidate without replacing the valid map', async () => {
    const initial = await mapWorkflow(root, { full: true }, { ...deps(root), git: new SystemGit() });
    expect(initial.ok).toBe(true);
    const paths = new RijoPaths(root);
    const previousClaims = fs.readFileSync(path.join(paths.codebaseDir, 'claims.json'), 'utf8');
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'map-review-001',
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'semantic overreach found',
        files_written: [],
        payload: {
          approved: false,
          findings: [
            {
              code: 'MISSING_EVIDENCE',
              message: 'The enriched responsibility claim overreaches its evidence.',
              evidence: [],
            },
          ],
        },
        scope_requests: [],
      }),
    );

    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });
    expect(outcome.status).toBe('blocked');
    expect(fs.readFileSync(path.join(paths.codebaseDir, 'claims.json'), 'utf8')).toBe(previousClaims);
    expect(d.runner.executed.some((task) => task.id === 'map-review-fallback-001')).toBe(false);
    const rejectionDir = path.join(paths.runtimeDir, 'map-review-rejections');
    const rejection = JSON.parse(
      fs.readFileSync(path.join(rejectionDir, fs.readdirSync(rejectionDir)[0]!), 'utf8'),
    );
    expect(rejection.status).toBe('REJECTED');
    expect(rejection.receipts.length).toBeGreaterThan(0);
    expect(rejection.receipts.some((receipt: any) => receipt.final_disposition === 'REJECTED')).toBe(true);
  });

  it('publishes a PARTIAL candidate when review rejects only an evidenced non-critical claim', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'map-review-001',
      (task) => {
        const marker = 'CANDIDATE CLAIM SHARD:\n';
        const claims = JSON.parse(
          task.notes
            .slice(task.notes.indexOf(marker) + marker.length)
            .split('\n\nAUTONOMOUS DECISION POLICY')[0]!,
        ) as Array<{
          evidence: Array<{ path: string; file_hash: string; ownership: 'primary' | 'external_contract' }>;
        }>;
        return {
          task_id: task.id,
          ok: true,
          summary: 'one non-critical semantic overreach found',
          files_written: [],
          payload: {
            approved: false,
            findings: [
              {
                code: 'MISSING_EVIDENCE',
                message: 'One convention claim overreaches the cited source.',
                evidence: claims[0]!.evidence,
              },
            ],
          },
          scope_requests: [],
        };
      },
    );

    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });
    expect(outcome.ok, outcome.message).toBe(true);
    const paths = new RijoPaths(root);
    const state = JSON.parse(fs.readFileSync(paths.codebaseMapState, 'utf8'));
    const receipts = JSON.parse(fs.readFileSync(path.join(paths.codebaseDir, 'review-receipts.json'), 'utf8'));
    expect(state.status).toBe('PARTIAL');
    expect(state.coverage.claims_verified).toBeLessThan(1);
    expect(receipts.claim_receipts.some((receipt: any) => receipt.final_disposition === 'REJECTED')).toBe(true);
    expect(receipts.claim_receipts.some((receipt: any) => receipt.final_disposition === 'APPROVED')).toBe(true);
  });

  it('refuses a dirty checkout without corrupting the durable checkpoint needed for a clean retry', async () => {
    const paths = new RijoPaths(root);
    fs.mkdirSync(paths.root, { recursive: true });
    writeState(
      paths,
      {
        ...initialState(),
        milestone: 'M001',
        phase: '01',
        stage: 'DONE',
        next_step: 'rijo map',
      },
      'Verified phase checkpoint.',
    );
    const checkpoint = fs.readFileSync(paths.state, 'utf8');
    fs.appendFileSync(path.join(root, 'src', 'auth', 'service.ts'), '\n// uncommitted user edit\n');

    const outcome = await mapWorkflow(root, {}, { ...deps(root), git: new SystemGit() });

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/clean checkout/i);
    expect(fs.readFileSync(paths.state, 'utf8')).toBe(checkpoint);
    expect(fs.existsSync(paths.manifest)).toBe(false);
  });

  it('is a no-op while fresh, then incrementally refreshes only changed modules', async () => {
    const d = deps(root);
    const wired = { ...d, git: new SystemGit() };
    expect((await mapWorkflow(root, {}, wired)).ok).toBe(true);
    const firstTasks = d.runner.executed.filter((t) => t.id.startsWith('map-shard-')).length;

    const noOp = await mapWorkflow(root, {}, wired);
    expect(noOp.ok).toBe(true);
    expect(noOp.message).toMatch(/fresh|current|no-op/i);
    expect(d.runner.executed.filter((t) => t.id.startsWith('map-shard-')).length).toBe(firstTasks);

    fs.appendFileSync(path.join(root, 'src', 'auth', 'service.ts'), '\nexport const authVersion = 2;\n');
    git(root, ['add', 'src/auth/service.ts']);
    git(root, ['commit', '-m', 'feat(auth): evolve public contract']);
    const incremental = await mapWorkflow(root, {}, wired);
    expect(incremental.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(new RijoPaths(root).codebaseMapState, 'utf8'));
    expect(state.last_operation).toBe('incremental');
    expect(state.changed_paths_since_map).toContain('src/auth/service.ts');
  });

  it('does not turn a documentation-only incremental shard into a blocking code coverage gap', async () => {
    const d = deps(root);
    const wired = { ...d, git: new SystemGit() };
    expect((await mapWorkflow(root, {}, wired)).ok).toBe(true);

    fs.writeFileSync(path.join(root, 'PLAN.md'), '# Future work\n\nAdd a counter command in a later phase.\n');
    git(root, ['add', 'PLAN.md']);
    git(root, ['commit', '-m', 'docs: add future implementation plan']);
    d.runner.on(
      (task) => task.id.startsWith('map-shard-'),
      (task) => {
        const marker = 'SHARD INVENTORY:\n';
        const inventory = JSON.parse(
          task.notes
            .slice(task.notes.indexOf(marker) + marker.length)
            .split('\n\nREQUIRED SEMANTIC COVERAGE MATRIX:')[0]!
            .split('\n\nAUTONOMOUS DECISION POLICY')[0]!,
        ) as Array<{
          path: string;
          module_id: string;
          file_hash: string;
        }>;
        return {
          task_id: task.id,
          ok: true,
          summary: 'documentation shard inspected',
          files_written: [],
          payload: {
            shard_id: task.id,
            module_ids: [...new Set(inventory.map((entry) => entry.module_id))],
            claims: [],
            gaps: [],
          },
          scope_requests: [],
        };
      },
    );

    const incremental = await mapWorkflow(root, {}, wired);

    expect(incremental.ok, incremental.message).toBe(true);
    const state = JSON.parse(fs.readFileSync(new RijoPaths(root).codebaseMapState, 'utf8'));
    expect(state.status).toBe('COMPLETE');
    expect(state.gaps).not.toContain(expect.stringMatching(/no source code/i));
  });

  it('records mapper observations but only lets reviewed or derived coverage gaps affect map status', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id.startsWith('map-shard-'),
      (task) => {
        const payload = mapFragmentFor(task) as {
          shard_id: string;
          module_ids: string[];
          claims: unknown[];
        gaps: Array<{ code: string; message: string; affected_paths: string[] }>;
      };
      payload.gaps = [
        {
          code: 'CONSUMER_UNKNOWN',
          message: 'No consumer of the newly exported revision marker is visible in the assigned shard.',
          affected_paths: [
            (
              payload.claims[0] as {
                evidence: Array<{ path: string }>;
              }
            ).evidence[0]!.path,
          ],
        },
      ];
        return {
          task_id: task.id,
          ok: true,
          summary: 'mapper observation recorded',
          files_written: [],
          payload,
          scope_requests: [],
        };
      },
    );

    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });

    expect(outcome.ok, outcome.message).toBe(true);
    const paths = new RijoPaths(root);
    const state = JSON.parse(fs.readFileSync(paths.codebaseMapState, 'utf8'));
    expect(state.status).toBe('PARTIAL');
    expect(state.gaps).toContainEqual(expect.stringMatching(/no consumer/i));
    const receipts = JSON.parse(
      fs.readFileSync(path.join(paths.codebaseDir, 'review-receipts.json'), 'utf8'),
    );
    expect(receipts.mapper_observations).toContainEqual(
      expect.objectContaining({
        shard_id: expect.stringMatching(/^map-shard-/),
        message: expect.stringMatching(/no consumer/i),
        review_status: 'APPROVED_NON_BLOCKING',
      }),
    );
  });

  it('answers deterministic queries and status without dispatching a model', async () => {
    const d = deps(root);
    await mapWorkflow(root, {}, { ...d, git: new SystemGit() });
    const before = d.runner.executed.length;
    const query = queryCodebaseMap(root, 'validateSession');
    expect(query.matches.length).toBeGreaterThan(0);
    expect(query.matches.some((m) => m.path === 'src/auth/service.ts')).toBe(true);
    const status = readCodebaseMapStatus(root);
    expect(status?.status).toBe('COMPLETE');
    expect(d.runner.executed.length).toBe(before);
  });

  it('honors --paths and preserves unaffected evidence claims', async () => {
    fs.mkdirSync(path.join(root, 'src', 'billing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'billing', 'service.ts'), 'export const charge = () => true;\n');
    git(root, ['add', 'src/billing/service.ts']);
    git(root, ['commit', '-m', 'feat(billing): add contract']);
    const d = deps(root);
    const wired = { ...d, git: new SystemGit() };
    expect((await mapWorkflow(root, { full: true }, wired)).ok).toBe(true);
    const claimsPath = path.join(new RijoPaths(root).codebaseDir, 'claims.json');
    const before = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
    const billingClaim = before.claims.find((claim: any) =>
      claim.evidence.some((evidence: any) => evidence.path === 'src/billing/service.ts'),
    );
    expect(billingClaim).toBeTruthy();

    const outcome = await mapWorkflow(root, { paths: ['src/auth'] }, wired);
    expect(outcome.ok, `${outcome.message}\n${outcome.details?.join('\n')}`).toBe(true);
    const after = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
    expect(after.claims).toContainEqual(billingClaim);
    expect(JSON.parse(fs.readFileSync(new RijoPaths(root).codebaseMapState, 'utf8')).last_operation).toBe('paths');
  });

  it('keeps the last valid map when promotion crashes before the commit point, then recovers', async () => {
    const initial = deps(root);
    expect((await mapWorkflow(root, {}, { ...initial, git: new SystemGit() })).ok).toBe(true);
    const statePath = new RijoPaths(root).codebaseMapState;
    const validState = fs.readFileSync(statePath, 'utf8');

    fs.appendFileSync(path.join(root, 'src', 'auth', 'service.ts'), '\nexport const secondGeneration = true;\n');
    git(root, ['add', 'src/auth/service.ts']);
    git(root, ['commit', '-m', 'refactor(auth): second generation']);
    await expect(
      mapWorkflow(root, {}, {
        ...deps(root),
        git: new SystemGit(),
        txnHooks: {
          afterWrite(step) {
            if (step === 'stage:.rijo/codebase/SUMMARY.md') throw new Error('simulated map staging crash');
          },
        },
      }),
    ).rejects.toThrow('simulated map staging crash');
    expect(fs.readFileSync(statePath, 'utf8')).toBe(validState);

    const recovered = await mapWorkflow(root, {}, { ...deps(root), git: new SystemGit() });
    expect(recovered.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).mapped_commit).toBe(git(root, ['rev-parse', 'HEAD~1']));
  });

  it('rejects a mapper that writes source inside its isolated read-only attempt', async () => {
    const d = deps(root);
    const original = fs.readFileSync(path.join(root, 'src', 'auth', 'service.ts'), 'utf8');
    d.runner.on(
      (task) => task.id.startsWith('map-shard-'),
      (task) => {
        const target = path.join(task.workspace!.root, 'src', 'auth', 'service.ts');
        fs.writeFileSync(target, 'export const compromised = true;\n');
        return {
          task_id: task.id,
          ok: true,
          summary: 'attempted write',
          files_written: [],
          payload: mapFragmentFor(task),
          scope_requests: [],
        };
      },
    );
    const outcome = await mapWorkflow(root, {}, { ...d, git: new SystemGit() });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/read-only workspace/i);
    expect(fs.readFileSync(path.join(root, 'src', 'auth', 'service.ts'), 'utf8')).toBe(original);
    expect(fs.existsSync(new RijoPaths(root).codebaseMapState)).toBe(false);
  });

  it('replaces a failed mapper with a fresh isolated generation', async () => {
    const d = deps(root);
    let attempts = 0;
    d.runner.on(
      (task) => task.id.startsWith('map-shard-'),
      (task) => {
        attempts++;
        if (attempts === 1) {
          return {
            task_id: task.id,
            ok: false,
            summary: 'simulated mapper process death',
            files_written: [],
            payload: null,
            scope_requests: [],
          };
        }
        return {
          task_id: task.id,
          ok: true,
          summary: 'replacement completed',
          files_written: [],
          payload: mapFragmentFor(task),
          scope_requests: [],
        };
      },
    );
    const outcome = await mapWorkflow(root, {}, {
      ...d,
      git: new SystemGit(),
      supervisorConfig: SupervisorConfigSchema.parse({
        max_replacements_per_task: 1,
        replacement_backoff_ms: [0],
      }),
    });
    expect(outcome.ok).toBe(true);
    const generations = d.runner.executed.filter((task) => task.id.startsWith('map-shard-'));
    expect(generations.length).toBeGreaterThanOrEqual(2);
    expect(new Set(generations.map((task) => task.workspace?.id)).size).toBeGreaterThanOrEqual(2);
  });

  it('reports an exhausted mapper result instead of misclassifying its discarded workspace', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id.startsWith('map-shard-'),
      (task) => ({
        task_id: task.id,
        ok: false,
        summary: 'mapper host remained unavailable',
        files_written: [],
        payload: null,
        scope_requests: [],
      }),
    );
    const config = defaultConfig();
    config.supervisor.max_replacements_per_task = 1;
    config.supervisor.replacement_backoff_ms = [0];
    fs.mkdirSync(path.join(root, '.rijo'), { recursive: true });
    saveConfig(new RijoPaths(root), config);
    git(root, ['add', '-f', '.rijo/config.yml']);
    git(root, ['commit', '-m', 'test: configure mapper replacement budget']);

    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/supervised mapper .* failed/i);
    expect(outcome.details?.join('\n')).toMatch(/exhausted|unavailable/i);
    expect(outcome.details?.join('\n')).not.toMatch(/workspace .* discarded/i);
  });

  it('repairs one schema-invalid mapper payload in a fresh supervised shard attempt', async () => {
    const d = deps(root);
    d.runner.on(
      (task) => task.id === 'map-shard-1',
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'malformed evidence',
        files_written: [],
        payload: {
          shard_id: task.id,
          module_ids: ['src/auth'],
          claims: [
            {
              kind: 'contract',
              statement: 'Missing hash must be rejected.',
              evidence: [{ path: 'src/auth/service.ts' }],
            },
          ],
          gaps: [],
        },
        scope_requests: [],
      }),
    );

    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });

    expect(outcome.ok, outcome.message).toBe(true);
    expect(d.runner.executed.some((task) => task.id === 'map-shard-1-correction')).toBe(true);
  });

  it('blocks an insufficient mapper after its single correction and preserves the previous map', async () => {
    const initial = await mapWorkflow(root, { full: true }, { ...deps(root), git: new SystemGit() });
    expect(initial.ok).toBe(true);
    const paths = new RijoPaths(root);
    const previousState = fs.readFileSync(paths.codebaseMapState, 'utf8');
    const previousClaims = fs.readFileSync(path.join(paths.codebaseDir, 'claims.json'), 'utf8');
    const d = deps(root);
    d.runner.on(
      (task) => task.id.startsWith('map-shard-1'),
      (task) => {
        const fragment = mapFragmentFor(task) as any;
        return {
          task_id: task.id,
          ok: true,
          summary: 'still semantically empty',
          files_written: [],
          payload: { ...fragment, claims: [], gaps: [] },
          scope_requests: [],
        };
      },
    );

    const outcome = await mapWorkflow(root, { full: true }, { ...d, git: new SystemGit() });

    expect(outcome.status).toBe('blocked');
    expect(d.runner.executed.some((task) => task.id === 'map-shard-1-correction')).toBe(true);
    expect(fs.readFileSync(paths.codebaseMapState, 'utf8')).toBe(previousState);
    expect(fs.readFileSync(path.join(paths.codebaseDir, 'claims.json'), 'utf8')).toBe(previousClaims);
  });

  it('falls back to a full map when the recorded base commit is no longer reachable', async () => {
    const wired = { ...deps(root), git: new SystemGit() };
    expect((await mapWorkflow(root, {}, wired)).ok).toBe(true);
    const paths = new RijoPaths(root);
    const previous = JSON.parse(fs.readFileSync(paths.codebaseMapState, 'utf8'));
    expect(previous.mapped_commit).not.toBe('');
    const mapHead = git(root, ['rev-parse', 'HEAD']);

    git(root, ['checkout', '--orphan', 'rewritten']);
    git(root, ['checkout', mapHead, '--', '.']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'chore: rewritten reachable history']);
    git(root, ['branch', '-D', 'main']);
    git(root, ['reflog', 'expire', '--expire=now', '--all']);
    git(root, ['gc', '--prune=now']);
    expect(fs.existsSync(paths.codebaseMapState)).toBe(true);
    expect(() => git(root, ['cat-file', '-e', `${previous.mapped_commit}^{commit}`])).toThrow();

    const outcome = await mapWorkflow(root, {}, wired);
    expect(outcome.ok).toBe(true);
    const state = JSON.parse(fs.readFileSync(paths.codebaseMapState, 'utf8'));
    expect(state.last_operation).toBe('full');
    expect(state.stale_reasons).toContain('mapped commit is no longer accessible; full remap performed');
  });
});

describe('Git history and brownfield baseline evidence', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject('rijo-map-history-');
    seedBrownfield(root);
  });

  afterEach(() => cleanup(root));

  it('records renames, migrations, architectural changes, and bug hotspots economically', () => {
    git(root, ['mv', 'src/auth/service.ts', 'src/auth/session.ts']);
    git(root, ['commit', '-m', 'refactor(auth): rename session contract']);
    fs.mkdirSync(path.join(root, 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'migrations', '001_sessions.sql'), 'create table sessions(id text primary key);\n');
    git(root, ['add', 'migrations/001_sessions.sql']);
    git(root, ['commit', '-m', 'feat(schema): add session migration']);
    fs.appendFileSync(path.join(root, 'src', 'auth', 'session.ts'), '\nexport const fixed = true;\n');
    git(root, ['add', 'src/auth/session.ts']);
    git(root, ['commit', '-m', 'fix(auth): session regression']);
    const history = collectGitHistory(root);
    expect(history.renames).toContainEqual(
      expect.objectContaining({ from: 'src/auth/service.ts', to: 'src/auth/session.ts' }),
    );
    expect(history.migrations.map((entry) => entry.path)).toContain('migrations/001_sessions.sql');
    expect(history.architectural_commits.length).toBeGreaterThan(0);
    expect(history.hotspots.some((entry) => entry.path === 'src/auth/session.ts')).toBe(true);
  });

  it('distinguishes PASSED, FAILED, and BLOCKED_BY_SANDBOX from mere detection', () => {
    const inventory = buildInventory(root);
    const passed = runBaseline(
      createContext(root, { ...deps(root), shell: new FakeShellRunner([], 0) }),
      inventory,
      'commit',
      'tree',
    );
    expect(passed.overall_status).toBe('PASSED');
    const failed = runBaseline(
      createContext(root, { ...deps(root), shell: new FakeShellRunner([], 1) }),
      inventory,
      'commit',
      'tree',
    );
    expect(failed.overall_status).toBe('FAILED');
    const blockedShell: ShellRunner = {
      run(command) {
        return {
          command,
          exit_code: 126,
          summary: 'blocked without exposing repository output',
          duration_ms: 0,
          blocked: true,
          category: 'test',
          sandbox: 'blocked',
        };
      },
    };
    const blocked = runBaseline(
      createContext(root, { ...deps(root), shell: blockedShell }),
      inventory,
      'commit',
      'tree',
    );
    expect(blocked.overall_status).toBe('BLOCKED_BY_SANDBOX');
    const detected = runBaseline(createContext(root, deps(root)), inventory, 'commit', 'tree', false);
    expect(detected.overall_status).toBe('DETECTED_NOT_RUN');
    expect(detected.commands.every((command) => command.exit_code === null)).toBe(true);
  });
});

describe('rijo new brownfield map integration', () => {
  let root: string;

  beforeEach(async () => {
    root = tmpProject('rijo-new-auto-map-');
    seedBrownfield(root);
    writePlanFile(root);
    git(root, ['add', 'PLAN.md']);
    git(root, ['commit', '-m', 'docs: add closed scope plan']);
    const mapped = await mapWorkflow(root, {}, { ...deps(root), git: new SystemGit() });
    expect(mapped.ok, JSON.stringify(mapped)).toBe(true);
  });

  afterEach(() => cleanup(root));

  it('uses the explicit map and gives the planner real paths and symbols', async () => {
    const d = deps(root);
    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, { ...d, git: new SystemGit() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(fs.existsSync(new RijoPaths(root).codebaseMapState)).toBe(true);
    const extract = d.runner.executed.find((t) => t.id === 'new-extract')!;
    expect(extract.notes).toContain('src/auth/service.ts');
    expect(extract.notes).toContain('validateSession');
    expect(extract.notes).toContain('AUTONOMOUS DECISION POLICY');
  });

  it('new --next refreshes a stale brownfield map before classifying the next milestone', async () => {
    const first = deps(root);
    const firstOutcome = await newWorkflow(root, { planFile: '@PLAN.md' }, { ...first, git: new SystemGit() });
    expect(firstOutcome.ok, JSON.stringify(firstOutcome)).toBe(true);
    fs.appendFileSync(
      path.join(root, 'src', 'auth', 'service.ts'),
      '\nexport function rotateSession() { return true; }\n',
    );
    fs.writeFileSync(path.join(root, 'PLAN-2.md'), '# Next milestone\n\nChange the existing session rotation.\n');
    git(root, ['add', 'src/auth/service.ts', 'PLAN-2.md']);
    git(root, ['commit', '-m', 'feat(auth): prepare session rotation milestone']);

    const second = deps(root);
    const refreshed = await mapWorkflow(root, {}, { ...second, git: new SystemGit() });
    expect(refreshed.ok, refreshed.message).toBe(true);
    const outcome = await newWorkflow(
      root,
      { planFile: '@PLAN-2.md', next: true },
      { ...second, git: new SystemGit() },
    );
    expect(outcome.ok, `${outcome.message}\n${outcome.details?.join('\n')}`).toBe(true);
    const state = JSON.parse(fs.readFileSync(new RijoPaths(root).codebaseMapState, 'utf8'));
    expect(state.last_operation).toBe('incremental');
    expect(state.changed_paths_since_map).toContain('src/auth/service.ts');
    const extract = second.runner.executed.find((task) => task.id === 'new-extract')!;
    expect(extract.notes).toContain('rotateSession');
    expect(extract.notes.indexOf('rotateSession')).toBeLessThan(extract.notes.indexOf('PLAN CONTENT'));
  });

  it('marks only verified phase source paths stale for the next incremental map', async () => {
    const d = deps(root);
    const outcome = await newWorkflow(root, { planFile: '@PLAN.md' }, { ...d, git: new SystemGit() });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const run = await runWorkflow(root, {}, { ...d, git: new SystemGit() });
    expect(run.ok).toBe(true);
    expect(d.runner.executed.find((task) => task.id === 'spec-01')?.notes).toContain('CODEBASE MAP CONTEXT');
    expect(d.runner.executed.find((task) => task.id.startsWith('plan-01-r'))?.notes).toContain(
      'CODEBASE MAP CONTEXT',
    );
    const stale = readStaleMarker(new RijoPaths(root));
    expect(stale?.changed_paths).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(stale?.changed_paths.every((changed) => !changed.startsWith('.rijo/'))).toBe(true);
  });

  it('run --all incrementally remaps phase impact before planning the next phase', async () => {
    const d = deps(root);
    const created = await newWorkflow(root, { planFile: '@PLAN.md' }, { ...d, git: new SystemGit() });
    expect(created.ok, created.message).toBe(true);
    const outcome = await runWorkflow(root, { target: 'all' }, { ...d, git: new SystemGit() });
    expect(outcome.ok, outcome.message).toBe(true);

    const state = JSON.parse(fs.readFileSync(new RijoPaths(root).codebaseMapState, 'utf8'));
    expect(state.last_operation).toBe('incremental');
    expect(state.changed_paths_since_map).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    const secondSpec = d.runner.executed.find((task) => task.id === 'spec-02')!;
    expect(secondSpec.notes).toContain('src/a.ts');
    expect(
      d.runner.executed.filter((task) => task.id.startsWith('map-shard-')).some((task) =>
        task.notes.includes('src/a.ts'),
      ),
    ).toBe(true);
    const events = fs
      .readFileSync(new RijoPaths(root).events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'run.map_context_fresh',
        data: expect.objectContaining({
          phase: '02',
          mapped_commit: state.mapped_commit,
          last_operation: 'incremental',
        }),
      }),
    );
  });

  it('invalidates and replans an existing unexecuted PLAN when its map becomes stale', async () => {
    const d = deps(root);
    const wired = { ...d, git: new SystemGit() };
    let failWorkers = true;
    d.runner.on(
      (task) => task.id.startsWith('exec-'),
      (task) => {
        if (failWorkers) {
          return { task_id: task.id, ok: false, summary: 'stop after plan persistence', files_written: [], payload: null, scope_requests: [] };
        }
        const written: string[] = [];
        for (const scope of task.write_scope) {
          if (scope.includes('*')) continue;
          const target = path.join(task.workspace!.root, scope);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, `// ${task.id}\n`);
          written.push(scope);
        }
        return { task_id: task.id, ok: true, summary: 'implemented after replan', files_written: written, payload: { done: true }, scope_requests: [] };
      },
    );
    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, wired)).ok).toBe(true);
    expect((await runWorkflow(root, {}, wired)).status).toBe('blocked');
    const firstPlanCalls = d.runner.executed.filter(
      (task) => task.id.startsWith('plan-01') && !task.id.startsWith('plan-review'),
    ).length;

    fs.appendFileSync(path.join(root, 'src', 'auth', 'service.ts'), '\nexport const externalRevision = 2;\n');
    git(root, ['add', 'src/auth/service.ts']);
    git(root, ['commit', '-m', 'feat(auth): external relevant change']);
    failWorkers = false;
    const resumedAfterStale = await runWorkflow(root, {}, wired);

    const planCallsAfterStale = d.runner.executed.filter(
      (task) => task.id.startsWith('plan-01') && !task.id.startsWith('plan-review'),
    ).length;
    expect(planCallsAfterStale, JSON.stringify(resumedAfterStale)).toBeGreaterThan(firstPlanCalls);
    const markerDir = path.join(root, '.rijo', 'runtime', 'plan-invalidations');
    const marker = JSON.parse(fs.readFileSync(path.join(markerDir, fs.readdirSync(markerDir)[0]!), 'utf8'));
    expect(marker.status).toBe('REPLANNED');
    expect(marker.reasons.join('\n')).toMatch(/mapped_|context_packet_hash/);
    const state = JSON.parse(fs.readFileSync(new RijoPaths(root).codebaseMapState, 'utf8'));
    expect(state.changed_paths_since_map).toContain('src/auth/service.ts');
  });

  it('recovers idempotently after a crash during durable plan invalidation', async () => {
    const d = deps(root);
    let failWorkers = true;
    d.runner.on(
      (task) => task.id.startsWith('exec-'),
      (task) => {
        if (failWorkers) {
          return { task_id: task.id, ok: false, summary: 'hold persisted plan', files_written: [], payload: null, scope_requests: [] };
        }
        const written = task.write_scope.map((scope) => {
          const target = path.join(task.workspace!.root, scope);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, `// ${task.id}\n`);
          return scope;
        });
        return { task_id: task.id, ok: true, summary: 'implemented', files_written: written, payload: { done: true }, scope_requests: [] };
      },
    );
    const wired = { ...d, git: new SystemGit() };
    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, wired)).ok).toBe(true);
    expect((await runWorkflow(root, {}, wired)).status).toBe('blocked');
    fs.appendFileSync(path.join(root, 'src', 'auth', 'service.ts'), '\nexport const crashRevision = 3;\n');
    git(root, ['add', 'src/auth/service.ts']);
    git(root, ['commit', '-m', 'feat(auth): trigger stale plan crash recovery']);

    let crashed = false;
    await expect(
      runWorkflow(root, {}, {
        ...wired,
        planHooks: {
          afterInvalidated: () => {
            if (!crashed) {
              crashed = true;
              throw new Error('simulated crash after invalidation marker');
            }
          },
        },
      }),
    ).rejects.toThrow(/simulated crash/);
    const markerDir = path.join(root, '.rijo', 'runtime', 'plan-invalidations');
    const markerPath = path.join(markerDir, fs.readdirSync(markerDir)[0]!);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).status).toBe('INVALIDATED');

    failWorkers = false;
    const recovered = await runWorkflow(root, {}, wired);
    expect(recovered.ok, recovered.message).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    expect(marker.status).toBe('REPLANNED');
    expect(marker.old_plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(marker.new_plan_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('blocks an existing applied PLAN when an external change overlaps its controlled paths', async () => {
    const d = deps(root);
    const wired = { ...d, git: new SystemGit() };
    d.runner.on(
      (task) => task.id.startsWith('code-review-'),
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: 'hold after implementation',
        files_written: [],
        payload: {
          approved: false,
          findings: [{ type: 'spec_gap', severity: 'critical', description: 'hold', file: 'src/a.ts' }],
        },
        scope_requests: [],
      }),
    );
    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, wired)).ok).toBe(true);
    expect((await runWorkflow(root, {}, wired)).status).toBe('blocked');
    fs.appendFileSync(path.join(root, 'src', 'a.ts'), '// external overlap\n');
    const before = fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8');

    const resumed = await runWorkflow(root, {}, wired);
    expect(resumed.status).toBe('blocked');
    expect(resumed.message).toMatch(/external changes overlap/i);
    expect(resumed.details?.join('\n')).toContain('src/a.ts');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf8')).toBe(before);
  });

  it('records a non-overlapping external change and continues an applied PLAN without replanning', async () => {
    const d = deps(root);
    const wired = { ...d, git: new SystemGit() };
    let holdReview = true;
    d.runner.on(
      (task) => task.id.startsWith('code-review-'),
      (task) => ({
        task_id: task.id,
        ok: true,
        summary: holdReview ? 'hold after implementation' : 'approved after unrelated change',
        files_written: [],
        payload: holdReview
          ? {
              approved: false,
              findings: [{ type: 'spec_gap', severity: 'critical', description: 'hold', file: 'src/a.ts' }],
            }
          : { approved: true, findings: [] },
        scope_requests: [],
      }),
    );
    expect((await newWorkflow(root, { planFile: '@PLAN.md' }, wired)).ok).toBe(true);
    expect((await runWorkflow(root, {}, wired)).status).toBe('blocked');
    const planCalls = d.runner.executed.filter(
      (task) => task.id.startsWith('plan-01') && !task.id.startsWith('plan-review'),
    ).length;
    fs.writeFileSync(path.join(root, 'notes.txt'), 'external but unrelated\n');
    holdReview = false;

    await runWorkflow(root, {}, wired);
    const resumedPlanCalls = d.runner.executed.filter(
      (task) => task.id.startsWith('plan-01') && !task.id.startsWith('plan-review'),
    ).length;
    const markerDir = path.join(root, '.rijo', 'runtime', 'plan-invalidations');
    const diagnostic = fs.existsSync(markerDir)
      ? fs.readFileSync(path.join(markerDir, fs.readdirSync(markerDir)[0]!), 'utf8')
      : fs.readFileSync(new RijoPaths(root).events, 'utf8').slice(-4000);
    expect(resumedPlanCalls, diagnostic).toBe(planCalls);
    expect(fs.readFileSync(new RijoPaths(root).events, 'utf8')).toContain('run.external_change_non_overlapping');
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('external but unrelated\n');
  });
});
