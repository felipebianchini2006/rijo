import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import YAML from 'yaml';
import { newWorkflow } from '../src/workflows/new.js';
import { runWorkflow } from '../src/workflows/run.js';
import { checkWorkflow } from '../src/workflows/check.js';
import { SystemGit } from '../src/core/git.js';
import { SystemShellRunner } from '../src/core/commands.js';
import { nativeSandboxAvailable } from '../src/security/execpolicy.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { parseFrontmatter } from '../src/core/frontmatter.js';
import { tmpProject, cleanup, writePlanFile, deps, mappedNewReferenceFor } from './helpers.js';

/**
 * REAL production-gate E2E: real git repository, real npm install, real HTTP
 * server started and stopped by RIJO, real Playwright (chromium) driving a
 * real form flow on desktop and mobile viewports. No fake runner is used for
 * any of the gate mechanics — only the planning agents are faked.
 */

const PORT = 3199;
const SERVER_JS = `'use strict';
const http = require('http');
const PORT = process.env.PORT || ${PORT};
const page = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Loja Fixture</title></head><body>',
  '<h1 id="title">Loja Fixture</h1>',
  '<form id="form"><input id="name" name="name"><button id="submit" type="button">Enviar</button></form>',
  '<div id="result"></div>',
  '<script>',
  "document.getElementById('submit').addEventListener('click', async () => {",
  "  const name = document.getElementById('name').value;",
  "  const res = await fetch('/api/greet?name=' + encodeURIComponent(name));",
  '  const data = await res.json();',
  "  document.getElementById('result').textContent = data.greeting;",
  '});',
  '</scr' + 'ipt></body></html>',
].join('');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (u.pathname === '/api/greet') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ greeting: 'Olá, ' + (u.searchParams.get('name') || '') }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(PORT, '127.0.0.1');
`;

const FIXTURE_EXTRACTION = {
  project_name: 'Loja Fixture',
  project_summary: 'Formulário de saudação com backend real.',
  stack_summary: 'Node http server, sem dependências de runtime.',
  rules: [],
  out_of_scope: [],
  acceptance: ['Usuário envia o nome e vê a saudação'],
  requirements: [
    { description: 'Saudação personalizada via formulário', acceptance: 'Usuário digita o nome, envia e vê "Olá, <nome>"', non_functional: false, classification: 'NEW' as const },
  ],
  phases: [{ name: 'Saudação', requirement_indexes: [0], depends_on_indexes: [], ui_surface: false }],
  research_topics: [],
};

function fixturePlan(root: string) {
  return (phaseId: string) => {
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const m = manifest.milestones.find((x) => x.id === manifest.active_milestone)!;
    const reqPath = path.join(paths.milestoneDir(m.id, m.slug), 'REQUIREMENTS.md');
    const reqIds = fs.existsSync(reqPath)
      ? (parseFrontmatter<{ requirements: Array<{ id: string; phase: string | null }> }>(fs.readFileSync(reqPath, 'utf8')).data.requirements ?? [])
          .filter((r) => r.phase === phaseId)
          .map((r) => r.id)
      : [];
    return {
      phase: phaseId,
      tasks: [
        { id: 'T01', name: 'Implementar saudação', requirement_ids: reqIds, technical_justification: null, files: ['a.js'], mapped_references: [mappedNewReferenceFor(root, 'a.js')], write_scope: ['a.js'], depends_on: [], parallel: false, tdd: false, tests: ['node test.js'], evidence_expected: 'teste passa', done: false },
        { id: 'T02', name: 'Integração', requirement_ids: [], technical_justification: 'integração', files: ['b.js'], mapped_references: [mappedNewReferenceFor(root, 'b.js')], write_scope: ['b.js'], depends_on: ['T01'], parallel: false, tdd: false, tests: [], evidence_expected: 'build passa', done: false },
      ],
    };
  };
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return (r.stdout ?? '').trim();
}

const canRun = process.platform === 'darwin' && nativeSandboxAvailable();

describe.runIf(canRun)('production gate E2E (real app, real server, real Playwright)', () => {
  let root: string;
  let mdir: string;

  beforeAll(async () => {
    root = fs.realpathSync(tmpProject('rijo-gate-'));
    // ---- real minimal application fixture
    fs.writeFileSync(path.join(root, 'server.js'), SERVER_JS);
    fs.writeFileSync(path.join(root, 'build.js'), `console.log('build ok');\n`);
    fs.writeFileSync(path.join(root, 'test.js'), `console.log('unit ok');\n`);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'loja-fixture',
          version: '1.0.0',
          private: true,
          scripts: { start: 'node server.js', build: 'node build.js', test: 'node test.js' },
          devDependencies: { '@playwright/test': '1.61.1' },
        },
        null,
        2,
      ),
    );
    const install = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, encoding: 'utf8' });
    expect(install.status, install.stderr).toBe(0);
    writePlanFile(root);
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'gate@example.com']);
    git(root, ['config', 'user.name', 'Gate Test']);
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'fixture app']);

    // ---- RIJO project: plan agents faked, git/shell REAL
    const d = { ...deps(root, { extraction: FIXTURE_EXTRACTION, planPayload: fixturePlan(root) }), git: new SystemGit(), shell: new SystemShellRunner() };
    const created = await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    expect(created.ok, created.message).toBe(true);
    const ran = await runWorkflow(root, { target: 'all' }, d);
    expect(ran.ok, JSON.stringify(ran)).toBe(true);

    // ---- structured journey actions + qa gate configuration (versioned, committed)
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const m = manifest.milestones[0]!;
    mdir = paths.milestoneDir(m.id, m.slug);
    fs.mkdirSync(path.join(mdir, 'qa', 'journeys'), { recursive: true });
    fs.writeFileSync(
      path.join(mdir, 'qa', 'journeys', 'j01.actions.json'),
      JSON.stringify({
        journey_id: 'J01',
        actions: [
          { action: 'goto', path: '/' },
          { action: 'expect_visible', selector: '#title', requirement_id: 'M001-REQ-001' },
          { action: 'fill', selector: '#name', value: 'Maria' },
          { action: 'click', selector: '#submit' },
          { action: 'expect_text', selector: '#result', text: 'Olá, Maria', requirement_id: 'M001-REQ-001' },
        ],
      }),
    );
    const configPath = paths.config;
    const cfg = YAML.parse(fs.readFileSync(configPath, 'utf8'));
    cfg.qa = {
      start_command: ['node', 'server.js'],
      base_url: `http://127.0.0.1:${PORT}`,
      health_url: `http://127.0.0.1:${PORT}/health`,
      startup_timeout_ms: 30000,
      shutdown_timeout_ms: 5000,
      browsers: ['chromium'],
      viewports: [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ],
      waivers: [],
    };
    fs.writeFileSync(configPath, YAML.stringify(cfg, { lineWidth: 0 }));
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'qa gate configuration + journey actions']);
  }, 300_000);

  afterAll(() => cleanup(root));

  it('READY: clean checkout of the exact commit, real server, real Playwright on desktop+mobile', async () => {
    const d = { ...deps(root, { extraction: FIXTURE_EXTRACTION }), git: new SystemGit(), shell: new SystemShellRunner() };
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const outcome = await checkWorkflow(root, { production: true }, d);
    expect(outcome.ok, `${outcome.message}\n${outcome.details?.join('\n')}`).toBe(true);

    const readiness = fs.readFileSync(path.join(mdir, 'qa', 'production-readiness.md'), 'utf8');
    const fm = parseFrontmatter<Record<string, unknown>>(readiness).data;
    expect(fm['status']).toBe('READY');
    expect(fm['tested_commit']).toBe(headBefore);
    expect(fm['evidence_commit']).toBeTruthy();
    const versions = fm['tool_versions'] as Record<string, string>;
    expect(versions['playwright']).toContain('1.61');
    expect(versions['node']).toContain('v');
    const commands = fm['commands'] as Array<{ command: string; exit_code: number }>;
    expect(commands.some((c) => c.command.startsWith('npm ci'))).toBe(true);
    expect(commands.some((c) => c.command.includes('playwright test'))).toBe(true);
    expect(commands.every((c) => c.exit_code === 0)).toBe(true);
    const journeys = fm['journeys'] as Array<{ id: string; passed: boolean | null }>;
    expect(journeys).toHaveLength(1);
    expect(journeys[0]!.passed).toBe(true);
    // tree is clean and HEAD advanced only by the evidence commits
    expect(git(root, ['status', '--porcelain', '-uall'])).toBe('');
  }, 300_000);

  it('BLOCKED: a dirty tree stops the gate before anything runs', async () => {
    fs.appendFileSync(path.join(root, 'server.js'), '\n// uncommitted edit\n');
    try {
      const d = { ...deps(root, { extraction: FIXTURE_EXTRACTION }), git: new SystemGit(), shell: new SystemShellRunner() };
      const outcome = await checkWorkflow(root, { production: true }, d);
      expect(outcome.ok).toBe(false);
      expect(`${outcome.message} ${outcome.details?.join(' ')}`).toMatch(/dirty/i);
    } finally {
      git(root, ['checkout', '--', 'server.js']);
    }
  }, 120_000);

  it('NOT_READY with failure evidence: Playwright fails when the real flow is broken', async () => {
    // sabotage the API so the journey assertion fails
    const broken = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace("'Olá, '", "'Tchau, '");
    fs.writeFileSync(path.join(root, 'server.js'), broken);
    git(root, ['add', 'server.js']);
    git(root, ['commit', '-m', 'introduce regression']);

    const d = { ...deps(root, { extraction: FIXTURE_EXTRACTION }), git: new SystemGit(), shell: new SystemShellRunner() };
    const outcome = await checkWorkflow(root, { production: true }, d);
    expect(outcome.ok).toBe(false);

    const readiness = fs.readFileSync(path.join(mdir, 'qa', 'production-readiness.md'), 'utf8');
    const fm = parseFrontmatter<Record<string, unknown>>(readiness).data;
    expect(fm['status'], `outcome: ${outcome.message}\n${outcome.details?.join('\n')}\n---\n${readiness.slice(0, 1500)}`).toBe('NOT_READY');
    const journeys = fm['journeys'] as Array<{ id: string; passed: boolean | null }>;
    expect(journeys[0]!.passed).toBe(false);
    // failure evidence exists on disk (traces/screenshots from the real run)
    const evidenceDir = fm['evidence_dir'] as string;
    expect(fs.existsSync(evidenceDir)).toBe(true);
    const artifacts = fs.existsSync(path.join(evidenceDir, 'artifacts'))
      ? fs.readdirSync(path.join(evidenceDir, 'artifacts'), { recursive: true }) as string[]
      : [];
    expect(artifacts.length).toBeGreaterThan(0);
    // server log captured
    expect(fs.existsSync(fm['server_log'] as string)).toBe(true);
  }, 300_000);

  it('check --fix repairs in an isolated workspace, commits, and re-runs the ENTIRE matrix to READY', async () => {
    const d = { ...deps(root, { extraction: FIXTURE_EXTRACTION }), git: new SystemGit(), shell: new SystemShellRunner() };
    // the repair worker fixes the sabotaged greeting inside its workspace
    d.runner.on(
      (t) => t.id.startsWith('check-fix-'),
      (t) => {
        const base = t.workspace!.root;
        const src = fs.readFileSync(path.join(base, 'server.js'), 'utf8').replace("'Tchau, '", "'Olá, '");
        fs.writeFileSync(path.join(base, 'server.js'), src);
        return {
          task_id: t.id, ok: true, summary: 'greeting restored', files_written: ['server.js'],
          payload: { done: true, notes: 'root cause: inverted greeting' }, scope_requests: [],
        };
      },
    );
    const outcome = await checkWorkflow(root, { production: true, fix: true }, d);
    expect(outcome.ok, `${outcome.message}\n${outcome.details?.join('\n')}`).toBe(true);

    const readiness = fs.readFileSync(path.join(mdir, 'qa', 'production-readiness.md'), 'utf8');
    const fm = parseFrontmatter<Record<string, unknown>>(readiness).data;
    expect(fm['status']).toBe('READY');
    // the fix produced a commit and the certified commit is the FIXED one
    const fixes = fm['fixes_applied'] as string[];
    expect(fixes.length).toBeGreaterThan(0);
    expect(fm['tested_commit']).toBe(git(root, ['log', '--pretty=%H', '--grep=check-fix', '-1']));
    // the whole matrix ran again on the new commit (install, build, test, playwright)
    const commands = fm['commands'] as Array<{ command: string; exit_code: number }>;
    expect(commands.some((c) => c.command.includes('playwright test'))).toBe(true);
    expect(commands.every((c) => c.exit_code === 0)).toBe(true);
    expect(git(root, ['status', '--porcelain', '-uall'])).toBe('');
  }, 300_000);
});
