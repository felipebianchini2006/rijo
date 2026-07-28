import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeAgentRunner, type RunnerCapabilities } from '../src/agents/runner.js';
import { FakeShellRunner } from '../src/core/commands.js';
import { FakeGit } from '../src/core/git.js';
import { silentSink } from '../src/core/progress.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRequirements } from '../src/core/roadmap.js';
import { exists } from '../src/core/fsx.js';
import { createWorkflowEpoch } from '../src/core/workflow-epoch.js';
import { uiImportId } from '../src/workflows/ui.js';
import type { WorkflowDeps } from '../src/workflows/shared.js';
import type { AgentTask, AgentResult } from '../src/agents/protocol.js';

/** Requirement IDs assigned to a phase, read from the active milestone on disk. */
export function phaseReqIds(root: string, phaseId: string): string[] {
  const paths = new RijoPaths(root);
  const manifest = readManifest(paths);
  if (!manifest?.active_milestone) return [];
  const m = manifest.milestones.find((x) => x.id === manifest.active_milestone);
  if (!m) return [];
  const reqPath = paths.milestoneDir(m.id, m.slug) + '/REQUIREMENTS.md';
  if (!exists(reqPath)) return [];
  return readRequirements(reqPath).requirements.filter((r) => r.phase === phaseId).map((r) => r.id);
}

export function tmpProject(prefix = 'rijo-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export function writePlanFile(root: string, name = 'PLAN.md', content?: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(
    p,
    content ??
      [
        '# Development plan: Simple Store',
        '',
        'A small online store with a catalog and checkout.',
        '',
        '## Requirements',
        '- Product catalog with listing and search',
        '- Checkout with card payment',
        '',
        '## Out of scope',
        '- Loyalty program',
      ].join('\n'),
    'utf8',
  );
  return p;
}

export function ok(task: AgentTask, extra: Partial<AgentResult> = {}): AgentResult {
  return {
    task_id: task.id,
    ok: true,
    summary: `done ${task.id}`,
    files_written: [],
    payload: null,
    scope_requests: [],
    ...extra,
  };
}

export function uiSmokeOk(task: AgentTask, notes = 'The UI smoke passed.'): AgentResult {
  if (!task.workspace) throw new Error('The UI smoke task has no isolated workspace.');
  const scope = task.write_scope.find((entry) => entry.endsWith('/**'));
  if (!scope) throw new Error('The UI smoke task has no screenshot scope.');
  const directory = scope.slice(0, -3);
  const screenshot = `${directory}/${task.id}.png`;
  const absolute = path.join(task.workspace.root, screenshot);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(
    absolute,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`RIJO UI smoke evidence: ${task.id}\n`, 'utf8'),
    ]),
  );
  return ok(task, {
    files_written: [screenshot],
    payload: {
      passed: true,
      console_errors: [],
      network_errors: [],
      screenshot,
      notes,
    },
  });
}

/** Evidence-valid structured payload for a RIJO map shard fake. */
export function mapFragmentFor(task: AgentTask): unknown {
  const marker = 'SHARD INVENTORY:\n';
  const raw = task.notes
    .slice(task.notes.indexOf(marker) + marker.length)
    .split('\n\nREQUIRED SEMANTIC COVERAGE MATRIX:')[0]!
    .split('\n\nAUTONOMOUS DECISION POLICY')[0]!;
  const files = JSON.parse(raw) as Array<{
    path: string;
    module_id: string;
    file_hash: string;
    exports: string[];
    imports: string[];
    kind: string;
  }>;
  const modules = [...new Set(files.map((file) => file.module_id))];
  const claims = modules.flatMap((moduleId) => {
    const moduleFiles = files.filter((file) => file.module_id === moduleId);
    const anchor = moduleFiles[0]!;
    const evidence = [{ path: anchor.path, file_hash: anchor.file_hash }];
    return [
      {
        kind: 'responsibility',
        statement: `${moduleId} implements behavior evidenced by its assigned source shard.`,
        evidence,
      },
      {
        kind: 'convention',
        statement: `New ${moduleId} behavior belongs beside the assigned module files.`,
        evidence,
      },
      ...(moduleFiles.some((file) => file.exports.length > 0)
        ? [{ kind: 'contract', statement: `${moduleId} exposes its listed exports as entrypoints.`, evidence }]
        : []),
      ...(moduleFiles.some((file) => file.imports.length > 0 || file.kind === 'migration')
        ? [{ kind: 'data_flow', statement: `${moduleId} data and dependency flow follows its listed imports.`, evidence }]
        : []),
      ...(moduleFiles.some((file) => file.kind === 'test' || file.kind === 'configuration' || file.kind === 'script')
        ? [{ kind: 'operation', statement: `${moduleId} has test or operational behavior in its assigned files.`, evidence }]
        : []),
    ];
  });
  const categories = [
    'responsibility',
    'entrypoints',
    'contracts',
    'invariants',
    'dependencies',
    'consumers',
    'data_flow',
    'conventions',
    'tests',
    'operations',
    'risks',
    'placement',
  ] as const;
  const semanticCoverage = modules.flatMap((moduleId) => {
    const moduleFiles = files.filter((file) => file.module_id === moduleId);
    const hasExports = moduleFiles.some((file) => file.exports.length > 0);
    const hasImports = moduleFiles.some((file) => file.imports.length > 0);
    const hasTests = moduleFiles.some((file) => file.kind === 'test');
    const hasOperations = moduleFiles.some((file) => file.kind === 'configuration' || file.kind === 'script');
    const hasData = moduleFiles.some((file) => file.kind === 'migration');
    const covered = new Set([
      'responsibility',
      'conventions',
      'placement',
      ...(hasExports ? ['entrypoints', 'contracts'] : []),
      ...(hasImports ? ['dependencies'] : []),
      ...(hasTests ? ['tests'] : []),
      ...(hasOperations ? ['operations'] : []),
      ...(hasData ? ['data_flow'] : []),
    ]);
    return categories.map((category) => ({
      module_id: moduleId,
      category,
      status: covered.has(category) ? ('COVERED' as const) : ('NOT_APPLICABLE' as const),
      rationale: covered.has(category)
        ? `${category} is evidenced by the assigned module files`
        : `${category} is not present in the assigned inventory`,
    }));
  });
  return {
    shard_id: task.id.replace(/-correction$/, ''),
    module_ids: modules,
    claims,
    semantic_coverage: semanticCoverage,
    gaps: [],
  };
}

export const EXTRACTION_PAYLOAD = {
  project_name: 'Simple Store',
  project_summary: 'Small online store with a catalog and checkout.',
  stack_summary: 'Node.js 24 and TypeScript (verified).',
  rules: ['Do not write card data to logs.'],
  out_of_scope: ['Loyalty program'],
  acceptance: ['The complete purchase works end to end'],
  requirements: [
    { description: 'Product catalog with listing and search', acceptance: 'User sees the list and searches by name', non_functional: false, classification: 'NEW' },
    { description: 'Checkout with card payment', acceptance: 'User completes a purchase with a test card', non_functional: false, classification: 'NEW' },
  ],
  phases: [
    { name: 'Catalog', requirement_indexes: [0], depends_on_indexes: [], ui_surface: true },
    { name: 'Checkout', requirement_indexes: [1], depends_on_indexes: [0], ui_surface: true },
  ],
  research_topics: [{ key: 'node-lts', topic: 'Recommended Node.js LTS', volatile: true }],
};

export function newMappedReference(path: string, parentModule = 'greenfield-root') {
  return {
    path,
    intent: 'new' as const,
    parent_module: parentModule,
    placement_evidence: [{ path: '.', reason: 'greenfield project root' }],
  };
}

export function mappedNewReferenceFor(root: string, file: string) {
  const graphPath = path.join(root, '.rijo', 'codebase', 'dependency-graph.json');
  if (!fs.existsSync(graphPath)) return newMappedReference(file);
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8')) as {
    modules: Array<{ id: string; paths: string[] }>;
  };
  const destination = path.posix.dirname(file);
  const owner =
    graph.modules.find((module) =>
      module.paths.some((owned) => {
        const rootDir = path.posix.dirname(owned);
        return destination === rootDir || destination.startsWith(`${rootDir}/`);
      }),
    ) ?? graph.modules[0]!;
  const evidencePath = owner.paths[0]!;
  return {
    path: file,
    intent: 'new' as const,
    parent_module: owner.id,
    placement_evidence: [{ path: evidencePath, reason: 'existing mapped module root' }],
  };
}

export function testPlanFreshness() {
  return {
    mapped_commit: 'a'.repeat(40),
    mapped_tree_hash: 'b'.repeat(64),
    planned_at: '2026-07-26T00:00:00.000Z',
    context_packet_hash: 'c'.repeat(64),
    mapped_reference_hashes: {},
    decision_context_hash: 'd'.repeat(64),
  };
}

export function planPayloadFor(phaseId: string, reqIds: string[] = []) {
  return {
    phase: phaseId,
    tasks: [
      {
        id: 'T01',
        name: 'Implement module',
        // cover the phase's requirements so the bidirectional coverage lint passes
        requirement_ids: reqIds,
        technical_justification: reqIds.length ? null : 'phase infrastructure',
        files: ['src/a.ts'],
        mapped_references: [newMappedReference('src/a.ts')],
        write_scope: ['src/a.ts'],
        depends_on: [],
        parallel: false,
        tdd: true,
        tests: ['echo test-a'],
        evidence_expected: 'tests pass',
        done: false,
      },
      {
        id: 'T02',
        name: 'Integrate module',
        requirement_ids: [],
        technical_justification: 'integration',
        files: ['src/b.ts'],
        mapped_references: [newMappedReference('src/b.ts')],
        write_scope: ['src/b.ts'],
        depends_on: ['T01'],
        parallel: false,
        tdd: false,
        tests: [],
        evidence_expected: 'build passes',
        done: false,
      },
      {
        id: 'T03',
        name: 'Verify the integrated behavior',
        requirement_ids: [],
        technical_justification: 'phase verification',
        files: ['tests/integration.test.ts'],
        mapped_references: [newMappedReference('tests/integration.test.ts')],
        write_scope: ['tests/integration.test.ts'],
        depends_on: ['T02'],
        parallel: false,
        tdd: false,
        tests: ['echo integration'],
        evidence_expected: 'integration behavior passes',
        done: false,
      },
    ],
  };
}

function mappedPlanPayloadFor(root: string, phaseId: string, reqIds: string[]): unknown {
  const payload = planPayloadFor(phaseId, reqIds);
  const inventoryPath = path.join(root, '.rijo', 'codebase', 'inventory.json');
  const graphPath = path.join(root, '.rijo', 'codebase', 'dependency-graph.json');
  if (!fs.existsSync(inventoryPath) || !fs.existsSync(graphPath)) return payload;
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as {
    files: Array<{ path: string; file_hash: string; module_id: string }>;
  };
  for (const task of payload.tasks) {
    task.mapped_references = task.files.map((file) => {
      const existing = inventory.files.find((entry) => entry.path === file);
      if (existing) {
        return { path: file, intent: 'existing' as const, file_hash: existing.file_hash };
      }
      return mappedNewReferenceFor(root, file);
    });
  }
  return payload;
}

export interface StandardRunnerOpts {
  capabilities?: Partial<RunnerCapabilities>;
  reviewApproved?: boolean;
  planPayload?: (phaseId: string) => unknown;
  extraction?: unknown;
}

/**
 * A FakeAgentRunner wired with the standard happy-path handlers:
 * planner extraction, plan payload, approving reviewer,
 * succeeding workers, researcher with sources.
 */
export function standardRunner(root: string, opts: StandardRunnerOpts = {}): FakeAgentRunner {
  const caps: RunnerCapabilities = { subagents: true, parallelism: true, browser: false, ...opts.capabilities };
  const runner = new FakeAgentRunner(caps);
  runner
    .on(
      (t) => t.id === 'new-extract',
      (t) => ok(t, { payload: opts.extraction ?? EXTRACTION_PAYLOAD }),
    )
    .on(
      (t) => t.id.startsWith('new-research'),
      (t) =>
        ok(t, {
          payload: {
            summary: 'Node.js 24 is Active LTS.',
            sources: [
              {
                claim: 'Node.js 24 is Active LTS',
                source: 'nodejs.org previous releases',
                url: 'https://nodejs.org/en/about/previous-releases',
                checked_at: '2026-07-23T00:00:00.000Z',
                version: '24.x',
                confidence: 'high',
                tier: 'official',
              },
            ],
          },
        }),
    )
    .on(
      (t) => t.id === 'new-roadmap',
      (t) =>
        ok(t, {
          payload: {
            phases: (opts.extraction as typeof EXTRACTION_PAYLOAD | undefined)?.phases ??
              EXTRACTION_PAYLOAD.phases,
            rationale: 'The phases deliver observable behavior in dependency order.',
          },
        }),
    )
    .on(
      (t) => t.id.startsWith('plan-') && !t.id.startsWith('plan-review'),
      (t) => {
        const phaseId = t.id.match(/plan-(\d{2})/)?.[1] ?? '01';
        if (opts.planPayload) {
          const payload = opts.planPayload(phaseId);
          if (
            payload &&
            typeof payload === 'object' &&
            Array.isArray((payload as { tasks?: unknown[] }).tasks) &&
            (payload as { tasks: unknown[] }).tasks.length === 2
          ) {
            const tasks = (payload as { tasks: Array<Record<string, unknown>> }).tasks;
            const integrationTarget = tasks[1]!;
            tasks.push({
              ...integrationTarget,
              id: 'T03',
              name: 'Complete the bounded integration',
              requirement_ids: [],
              technical_justification: 'bounded integration',
              depends_on: ['T02'],
              parallel: false,
              tdd: false,
              tests: [],
              evidence_expected: 'The integration remains coherent.',
              done: false,
            });
          }
          return ok(t, { payload });
        }
        return ok(t, { payload: mappedPlanPayloadFor(root, phaseId, phaseReqIds(root, phaseId)) });
      },
    )
    .on(
      (t) => t.role === 'reviewer',
      (t) => {
        const approved = opts.reviewApproved ?? true;
        // A disapproving reviewer must carry a high-impact finding. Medium and
        // low observations remain non-blocking.
        const findings = approved
          ? []
          : [{ type: 'quality_issue', severity: 'critical', description: 'blocking review finding', file: null }];
        return ok(t, { payload: { approved, findings } });
      },
    )
    .on(
      (t) => t.id.startsWith('map-shard-'),
      (t) => ok(t, { payload: mapFragmentFor(t) }),
    )
    .on(
      (t) => t.role === 'worker' && t.id.startsWith('exec-'),
      (t) => {
        // simulate the worker touching its write scope inside its ISOLATED workspace
        const base = t.workspace?.root ?? root;
        const written: string[] = [];
        for (const scope of t.write_scope) {
          if (scope.includes('*')) continue;
          const target = path.join(base, scope);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, `// ${t.id}\n`, 'utf8');
          written.push(scope);
        }
        return ok(t, { files_written: written, payload: { done: true, notes: 'implemented' } });
      },
    );
  return runner;
}

/** Valid mapping payload for the UI import pipeline (all four states planned). */
export const UI_MAPPING_PAYLOAD = {
  mappings: [
    { from: 'index.html', to: 'app/page.tsx', kind: 'component', notes: 'home' },
    { from: 'about.html', to: 'app/about/page.tsx', kind: 'component', notes: 'about' },
    { from: 'assets/logo.svg', to: 'public/logo.svg', kind: 'asset', notes: '' },
  ],
  routes: [
    { from: 'index.html', to: '/' },
    { from: 'about.html', to: '/about' },
  ],
  divergences: [],
  states_covered: ['loading', 'empty', 'error', 'success'],
};

/**
 * Wire the standard UI import handlers: read-only mapper, workspace-writing
 * converter and passing browser validator. The fixture project gains a
 * package.json with a typecheck script so the target stack is verifiable.
 */
export function wireUi(
  d: { runner: FakeAgentRunner },
  root: string,
  opts: { mapping?: unknown; convert?: (t: AgentTask) => AgentResult; validatePassed?: boolean } = {},
): void {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { typecheck: 'tsc --noEmit' } }));
  }
  d.runner
    .on(
      (t) => t.id.startsWith('ui-map-'),
      (t) => ok(t, { payload: opts.mapping ?? UI_MAPPING_PAYLOAD }),
    )
    .on(
      (t) => t.id.startsWith('ui-convert-'),
      (t) => {
        if (opts.convert) return opts.convert(t);
        const base = t.workspace!.root;
        for (const scope of t.write_scope) {
          fs.mkdirSync(path.dirname(path.join(base, scope)), { recursive: true });
          fs.writeFileSync(path.join(base, scope), `// converted ${scope}\nexport default function Page() { return null; }\n`);
        }
        return ok(t, { payload: { converted: true, components_created: t.write_scope, notes: 'converted' } });
      },
    )
    .on(
      (t) => t.id.startsWith('ui-validate-'),
      (t) =>
        ok(t, {
          payload: {
            passed: opts.validatePassed ?? true,
            routes_checked: ['/', '/about'],
            states_checked: ['loading', 'empty', 'error', 'success'],
            notes: 'validated in real browser runtime',
          },
        }),
    );
}

export function deps(root: string, opts: StandardRunnerOpts = {}): WorkflowDeps & { git: FakeGit; shell: FakeShellRunner; runner: FakeAgentRunner } {
  const git = new FakeGit();
  const shell = new FakeShellRunner();
  const runner = standardRunner(root, opts);
  return { runner, shell, git, sink: silentSink, now: () => new Date('2026-07-23T12:00:00.000Z') };
}

/**
 * Give one UI invocation its own operation epoch and expose the matching
 * import directory without coupling tests to the injectable wall clock.
 */
export function uiOperation<T extends WorkflowDeps>(root: string, baseDeps: T) {
  const workflowEpoch = createWorkflowEpoch();
  return {
    deps: { ...baseDeps, workflowEpoch },
    importDir: path.join(new RijoPaths(root).importsDir, uiImportId(workflowEpoch)),
    workflowEpoch,
  };
}
