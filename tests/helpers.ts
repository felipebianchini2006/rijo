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
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

export function writePlanFile(root: string, name = 'PLANO.md', content?: string): string {
  const p = path.join(root, name);
  fs.writeFileSync(
    p,
    content ??
      [
        '# Plano — Loja simples',
        '',
        'Uma loja online mínima com catálogo e checkout.',
        '',
        '## Requisitos',
        '- Catálogo de produtos com listagem e busca',
        '- Checkout com pagamento por cartão',
        '',
        '## Fora de escopo',
        '- Programa de fidelidade',
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

export const EXTRACTION_PAYLOAD = {
  project_name: 'Loja Simples',
  project_summary: 'Loja online mínima com catálogo e checkout.',
  stack_summary: 'Node.js 24 + TypeScript (verificado).',
  rules: ['Sem dados de cartão em logs.'],
  out_of_scope: ['Programa de fidelidade'],
  acceptance: ['Compra completa funciona de ponta a ponta'],
  requirements: [
    { description: 'Catálogo de produtos com listagem e busca', acceptance: 'Usuário vê lista e busca por nome', non_functional: false, classification: 'NEW' },
    { description: 'Checkout com pagamento por cartão', acceptance: 'Usuário conclui compra com cartão de teste', non_functional: false, classification: 'NEW' },
  ],
  phases: [
    { name: 'Catálogo', requirement_indexes: [0], depends_on_indexes: [], ui_surface: true },
    { name: 'Checkout', requirement_indexes: [1], depends_on_indexes: [0], ui_surface: true },
  ],
  research_topics: [{ key: 'node-lts', topic: 'Node.js LTS recomendado', volatile: true }],
};

export function planPayloadFor(phaseId: string, reqIds: string[] = []) {
  return {
    phase: phaseId,
    tasks: [
      {
        id: 'T01',
        name: 'Implementar módulo',
        // cover the phase's requirements so the bidirectional coverage lint passes
        requirement_ids: reqIds,
        technical_justification: reqIds.length ? null : 'infra da fase',
        files: ['src/a.ts'],
        write_scope: ['src/a.ts'],
        depends_on: [],
        parallel: false,
        tdd: true,
        tests: ['echo test-a'],
        evidence_expected: 'testes passam',
        done: false,
      },
      {
        id: 'T02',
        name: 'Integrar módulo',
        requirement_ids: [],
        technical_justification: 'integração',
        files: ['src/b.ts'],
        write_scope: ['src/b.ts'],
        depends_on: ['T01'],
        parallel: false,
        tdd: false,
        tests: [],
        evidence_expected: 'build passa',
        done: false,
      },
    ],
  };
}

export interface StandardRunnerOpts {
  capabilities?: Partial<RunnerCapabilities>;
  reviewApproved?: boolean;
  planPayload?: (phaseId: string) => unknown;
  extraction?: unknown;
}

/**
 * A FakeAgentRunner wired with the standard happy-path handlers:
 * planner extraction, spec writer, plan payload, approving reviewer,
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
            summary: 'Node 24 é o Active LTS.',
            sources: [
              {
                claim: 'Node.js 24 é Active LTS',
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
      (t) => t.id.startsWith('spec-'),
      (t) => {
        // spec writer runs in an isolated workspace; the relative spec path is its write scope
        const base = t.workspace?.root ?? root;
        const specPath = path.isAbsolute(t.write_scope[0]!) ? t.write_scope[0]! : path.join(base, t.write_scope[0]!);
        fs.mkdirSync(path.dirname(specPath), { recursive: true });
        fs.writeFileSync(specPath, `# Spec\n\nCenários observáveis de aceite.\n`, 'utf8');
        return ok(t, { files_written: [t.write_scope[0]!] });
      },
    )
    .on(
      (t) => t.id.startsWith('plan-') && !t.id.startsWith('plan-review'),
      (t) => {
        const phaseId = t.id.match(/plan-(\d{2})/)?.[1] ?? '01';
        if (opts.planPayload) return ok(t, { payload: opts.planPayload(phaseId) });
        return ok(t, { payload: planPayloadFor(phaseId, phaseReqIds(root, phaseId)) });
      },
    )
    .on(
      (t) => t.role === 'reviewer',
      (t) => {
        const approved = opts.reviewApproved ?? true;
        // A disapproving reviewer must carry a BLOCKING-severity finding: the
        // workflow only holds a plan for blocker/critical findings (mere high/
        // medium/low nitpicks never block), so an empty-finding or low-severity
        // rejection would be accepted.
        const findings = approved
          ? []
          : [{ type: 'quality_issue', severity: 'critical', description: 'blocking review finding', file: null }];
        return ok(t, { payload: { approved, findings } });
      },
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
