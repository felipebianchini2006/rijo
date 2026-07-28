import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, exists, readJsonIfExists, readText } from '../core/fsx.js';
import { buildEnv, seatbeltProfile } from '../security/execpolicy.js';
import type { GitOps } from '../core/git.js';
import type { ShellRunner, CommandEvidence } from '../core/commands.js';
import type { RijoConfig } from '../core/schemas/index.js';
import { loadJourneyActions, type Journey, type JourneyAction } from './journeys.js';
import { generatePlaywrightSpecs, lintPlaywrightSpec } from './playwright.js';

/**
 * The production gate: executable verification of the EXACT commit. A clean
 * checkout of tested_commit is materialized in an isolated workspace,
 * dependencies install reproducibly (lockfile, lifecycle scripts off, no
 * npx), the application starts and is health-checked, REAL Playwright drives
 * the structured journeys on every configured browser/viewport, and evidence
 * (json results, traces, screenshots, server log) is captured. Missing
 * browser, server or configuration → BLOCKED, never a silent pass.
 */

export interface GateJourneyResult {
  id: string;
  requirement_ids: string[];
  spec: string | null;
  passed: boolean | null; // null = not executed
  evidence: string[];
  failures: string[];
}

export interface GateReport {
  status: 'passed' | 'failed' | 'blocked';
  tested_commit: string;
  reasons: string[];
  commands: CommandEvidence[];
  journeys: GateJourneyResult[];
  tool_versions: Record<string, string>;
  evidence_dir: string | null;
  server_log: string | null;
}

export interface GateDeps {
  projectRoot: string;
  git: GitOps;
  shell: ShellRunner;
  config: RijoConfig;
  qaDir: string;
  now: () => Date;
  emit: (type: string, message: string) => void;
}

/** Windows needs a shell to resolve/execute .cmd shims (npm, playwright). */
const WIN_SHELL = process.platform === 'win32';

async function runShell(
  shell: ShellRunner,
  command: string,
  options: Parameters<ShellRunner['run']>[1],
): Promise<CommandEvidence> {
  if (shell.runAsync) return await shell.runAsync(command, options);
  return shell.run(command, options);
}

async function runPlaywright(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      shell: WIN_SHELL,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-(32 * 1024 * 1024));
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-(32 * 1024 * 1024));
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 1 : (code ?? 1),
        stdout,
        stderr: timedOut ? `${stderr}\nPlaywright timed out after ${timeoutMs}ms.`.trim() : stderr,
      });
    });
  });
}

function toolVersion(bin: string, args: string[], cwd?: string): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', cwd, shell: WIN_SHELL });
  return r.status === 0 ? (r.stdout ?? '').trim() : 'unavailable';
}

function requiresBrowserGate(
  projectRoot: string,
  config: RijoConfig,
  acceptanceById: Record<string, string>,
): boolean {
  if (config.qa.surface === 'web') return true;
  if (config.qa.surface === 'non_web') return false;
  if (config.qa.start_command.length > 0 || config.qa.health_url.length > 0) return true;

  const pkg = readJsonIfExists<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  }>(path.join(projectRoot, 'package.json'));
  const dependencyNames = Object.keys({
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  });
  const webDependency = dependencyNames.some((name) =>
    /^(?:@playwright\/test|next|nuxt|react|react-dom|vue|svelte|@sveltejs\/kit|astro|vite|angular|@angular\/core)$/.test(name),
  );
  const webScript = Boolean(pkg?.scripts?.['dev'] || pkg?.scripts?.['start']);
  const browserAcceptance = Object.values(acceptanceById).some((text) =>
    /\b(?:browser|page|screen|viewport|desktop|mobile|click|form|frontend|ui|web|responsive|button)\b/i.test(text),
  );
  return webDependency || webScript || browserAcceptance;
}

export async function runProductionGate(
  deps: GateDeps,
  journeys: Journey[],
  acceptanceById: Record<string, string>,
): Promise<GateReport> {
  const { projectRoot, git, config, now } = deps;
  const qa = config.qa;
  const browserGate = requiresBrowserGate(projectRoot, config, acceptanceById);
  const blockedReport = (reasons: string[], testedCommit = ''): GateReport => ({
    status: 'blocked',
    tested_commit: testedCommit,
    reasons,
    commands: [],
    journeys: journeys.map((j) => ({ id: j.id, requirement_ids: j.requirement_ids, spec: null, passed: null, evidence: [], failures: [] })),
    tool_versions: {},
    evidence_dir: null,
    server_log: null,
  });

  // ---- 1: exact commit, clean tree. The gate's OWN evidence area
  // (qa/traces) is exempt: multi-round --fix accumulates round evidence there
  // and everything is committed as evidence at the end of the check.
  const qaRelPre = path.relative(projectRoot, deps.qaDir).split(path.sep).join('/');
  const status = git.status(projectRoot);
  if (!status.isRepo) return blockedReport(['No git repository: the production gate certifies an exact commit.']);
  const dirtyForeign = status.dirtyFiles.filter(
    (f) => !f.startsWith(`${qaRelPre}/traces/`) && f !== '.rijo/events.jsonl',
  );
  if (dirtyForeign.length > 0) {
    return blockedReport([
      `Working tree is dirty (${dirtyForeign.length} files); commit or revert before the gate.`,
      ...dirtyForeign.slice(0, 10),
    ]);
  }
  const commit = git.headCommit(projectRoot);
  if (!commit) return blockedReport(['Cannot resolve HEAD commit.']);

  // ---- 2: configuration completeness
  const configIssues: string[] = [];
  const actionsByJourney: Record<string, JourneyAction[]> = {};
  if (browserGate) {
    if (qa.start_command.length === 0) configIssues.push('qa.start_command is empty');
    if (!qa.health_url) configIssues.push('qa.health_url is not set');
    if (qa.browsers.length === 0) configIssues.push('qa.browsers is empty');
    for (const j of journeys) {
      const actions = loadJourneyActions(deps.qaDir, j.id);
      if (!actions) configIssues.push(`journey ${j.id} has no structured actions file (qa/journeys/${j.id.toLowerCase()}.actions.json)`);
      else actionsByJourney[j.id] = actions.actions;
    }
  }
  if (configIssues.length > 0) return blockedReport(configIssues.map((i) => `Gate configuration incomplete: ${i}`), commit);

  // ---- 3: clean checkout of the exact commit in an isolated workspace
  const stamp = `${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${commit.slice(0, 8)}`;
  const gateDir = path.join(projectRoot, '.rijo', 'runtime', `gate-${stamp}`);
  if (!git.checkoutInto(projectRoot, commit, gateDir)) {
    return blockedReport([`Could not materialize a clean checkout of ${commit}.`], commit);
  }

  const commands: CommandEvidence[] = [];
  const evidenceDir = path.join(deps.qaDir, 'traces', `gate-${stamp}`);
  ensureDir(evidenceDir);
  let serverLogPath: string | null = null;
  let server: ReturnType<typeof spawn> | null = null;

  try {
    // ---- 4: reproducible dependencies (lockfile; lifecycle scripts off; no npx)
    const pkg = readJsonIfExists<{ devDependencies?: Record<string, string>; dependencies?: Record<string, string>; scripts?: Record<string, string> }>(
      path.join(gateDir, 'package.json'),
    );
    if (!pkg) return blockedReport(['Gate checkout has no package.json.'], commit);
    const hasPlaywright = Boolean(pkg.devDependencies?.['@playwright/test'] || pkg.dependencies?.['@playwright/test']);
    if (browserGate && !hasPlaywright) {
      return blockedReport(['Target project does not declare @playwright/test; the gate cannot run real browser journeys.'], commit);
    }
    if (exists(path.join(gateDir, 'package-lock.json'))) {
      deps.emit('gate.install', 'Installing dependencies with npm ci --ignore-scripts.');
      const ev = await runShell(deps.shell, 'npm ci --no-audit --no-fund', { cwd: gateDir, allowInstall: true, timeoutMs: 10 * 60 * 1000 });
      commands.push(ev);
      if (ev.exit_code !== 0) {
        return { ...blockedReport([`Dependency installation failed in the gate checkout (exit ${ev.exit_code}).`], commit), commands };
      }
    } else {
      return blockedReport(['No package-lock.json: reproducible installation is impossible.'], commit);
    }

    // The browser revision is coupled to the target project's Playwright
    // version. Provision it with the binary from this exact checkout instead
    // of trusting a global cache populated by an unrelated RIJO/CI version.
    if (browserGate) {
      const installCommand = `playwright install ${qa.browsers.join(' ')}`;
      deps.emit(
        'gate.install',
        `Installing the locked browser versions: ${qa.browsers.join(', ')}.`,
      );
      const browserInstall = await runShell(deps.shell, installCommand, {
        cwd: gateDir,
        allowInstall: true,
        timeoutMs: 10 * 60 * 1000,
      });
      commands.push(browserInstall);
      if (browserInstall.exit_code !== 0) {
        return {
          ...blockedReport(
            [
              `Playwright browser provisioning failed in the gate checkout (exit ${browserInstall.exit_code}).`,
              browserInstall.summary,
            ],
            commit,
          ),
          commands,
        };
      }
    }

    // ---- 5: deterministic checks inside the CHECKOUT (the exact commit)
    const deterministicCheckStart = commands.length;
    for (const script of ['typecheck', 'lint', 'build', 'test']) {
      if (pkg.scripts?.[script]) {
        const ev = await runShell(deps.shell, `npm run ${script}`, { cwd: gateDir });
        commands.push(ev);
        deps.emit('gate.check', `${script} → exit ${ev.exit_code}`);
      }
    }

    if (!browserGate) {
      const checks = commands.slice(deterministicCheckStart);
      if (checks.length === 0) {
        return {
          ...blockedReport(['Non-web project has no executable typecheck, lint, build, or test script to certify.'], commit),
          commands,
        };
      }
      const failedChecks = checks.filter((command) => command.exit_code !== 0);
      const passed = failedChecks.length === 0;
      return {
        status: passed ? 'passed' : 'failed',
        tested_commit: commit,
        reasons: passed
          ? ['Non-web surface: all deterministic checks passed in a clean checkout of the exact commit; browser gates are not applicable.']
          : failedChecks.map((command) => `Check failed: ${command.command} (exit ${command.exit_code})`),
        commands,
        journeys: journeys.map((journey) => ({
          id: journey.id,
          requirement_ids: journey.requirement_ids,
          spec: null,
          passed,
          evidence: checks.map((command) => command.command),
          failures: passed ? [] : failedChecks.map((command) => `${command.command} exited ${command.exit_code}`),
        })),
        tool_versions: {
          node: toolVersion(process.execPath, ['--version']),
          npm: toolVersion('npm', ['--version']),
          rijo_gate: 'deterministic non-web v1',
        },
        evidence_dir: evidenceDir,
        server_log: null,
      };
    }

    // ---- 6: deterministic spec codegen + anti-placeholder lint
    const specDir = path.join(gateDir, '.rijo-gate', 'specs');
    const specs = generatePlaywrightSpecs(journeys, specDir, qa.base_url, acceptanceById, actionsByJourney);
    for (const s of specs) {
      const journey = journeys.find((j) => j.id === s.journeyId)!;
      const issues = lintPlaywrightSpec(readText(s.file), journey);
      if (issues.length > 0) {
        return { ...blockedReport(issues.map((i) => `Spec ${s.journeyId}: ${i.code} — ${i.message}`), commit), commands };
      }
    }
    const pwConfigPath = path.join(gateDir, '.rijo-gate', 'playwright.config.cjs');
    const artifactsDir = path.join(gateDir, '.rijo-gate', 'artifacts');
    const resultsPath = path.join(gateDir, '.rijo-gate', 'results.json');
    fs.writeFileSync(pwConfigPath, renderPlaywrightConfig(specDir, artifactsDir, resultsPath, config));

    // ---- 7: start the application and wait for health
    deps.emit('gate.server', `Starting the application: ${qa.start_command.join(' ')}`);
    serverLogPath = path.join(evidenceDir, 'server.log');
    const serverLog = fs.openSync(serverLogPath, 'w');
    const serverEnv = { ...buildEnv(gateDir, config.execution), NODE_ENV: 'test' };
    // the application under test is repository code: on hosts with a native
    // sandbox it runs network-restricted (loopback only, writes inside the
    // checkout); sandbox-exec execs the target, so killing the pid kills the app.
    const useSeatbelt = process.platform === 'darwin' && exists('/usr/bin/sandbox-exec');
    const serverSpawn = useSeatbelt
      ? { bin: '/usr/bin/sandbox-exec', args: ['-p', seatbeltProfile(gateDir, 'restricted'), ...qa.start_command] }
      : { bin: qa.start_command[0]!, args: qa.start_command.slice(1) };
    server = spawn(serverSpawn.bin, serverSpawn.args, {
      cwd: gateDir,
      env: serverEnv,
      stdio: ['ignore', serverLog, serverLog],
      shell: false,
    });
    const healthy = await waitForHealth(qa.health_url, qa.startup_timeout_ms);
    if (!healthy) {
      return {
        ...blockedReport([`Application did not become healthy at ${qa.health_url} within ${qa.startup_timeout_ms}ms.`, `Server log: ${serverLogPath}`], commit),
        commands,
        server_log: serverLogPath,
      };
    }

    // ---- 8: REAL Playwright execution with structured (json) results
    deps.emit(
      'gate.playwright',
      `Running ${specs.length} journeys on ${qa.browsers.join(', ')} for ${qa.viewports.map((v) => v.name).join(', ')}.`,
    );
    const pwBin = path.join(gateDir, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
    if (!exists(pwBin)) {
      return { ...blockedReport(['Playwright binary missing from the checkout node_modules.'], commit), commands, server_log: serverLogPath };
    }
    const started = Date.now();
    const pwEnv = buildEnv(gateDir, config.execution);
    const pw = await runPlaywright(
      pwBin,
      ['test', `--config=${pwConfigPath}`],
      gateDir,
      pwEnv,
      config.execution.command_timeout_ms,
    );
    commands.push({
      command: 'playwright test (gate, RIJO-generated specs)',
      exit_code: pw.exitCode,
      summary: `${pw.stdout.slice(-1500)}\n${pw.stderr.slice(-500)}`.trim(),
      duration_ms: Date.now() - started,
      blocked: false,
      category: 'test',
      sandbox: 'gate-controlled (RIJO codegen specs; browser sandboxed by Chromium)',
      trust: 'known-script',
      network: 'restricted',
    });

    // ---- 9: structured result parsing + failure evidence
    const results = readJsonIfExists<PlaywrightJsonReport>(resultsPath);
    if (!results) {
      return { ...blockedReport(['Playwright produced no structured results file.'], commit), commands, server_log: serverLogPath };
    }
    const journeyResults = mapResults(journeys, specs.map((s) => ({ id: s.journeyId, file: s.file })), results);
    // copy failure artifacts (traces/screenshots) into the milestone evidence dir
    if (exists(artifactsDir)) {
      fs.cpSync(artifactsDir, path.join(evidenceDir, 'artifacts'), { recursive: true });
      for (const jr of journeyResults) {
        if (jr.passed === false) {
          jr.evidence.push(path.join(evidenceDir, 'artifacts'));
        }
      }
    }

    // ---- 10: nothing may have changed during the gate — except the gate's
    // own evidence files (qa/), which the caller commits as evidence.
    const after = git.status(projectRoot);
    const headAfter = git.headCommit(projectRoot);
    const foreignDirty = after.dirtyFiles.filter(
      (f) => !f.startsWith(`${qaRelPre}/traces/`) && f !== '.rijo/events.jsonl',
    );
    if (headAfter !== commit || foreignDirty.length > 0) {
      return {
        ...blockedReport(
          [`The repository changed during the gate (HEAD ${headAfter?.slice(0, 12)}, dirty: ${foreignDirty.length}); the result is invalid — re-run on the new commit.`, ...foreignDirty.slice(0, 10)],
          commit,
        ),
        commands,
        server_log: serverLogPath,
      };
    }

    const failed = journeyResults.filter((j) => j.passed !== true);
    const checkFailures = commands.filter((c) => c.exit_code !== 0);
    const passed = failed.length === 0 && checkFailures.length === 0;
    return {
      status: passed ? 'passed' : 'failed',
      tested_commit: commit,
      reasons: passed
        ? ['All journeys passed on every configured browser/viewport; all deterministic checks exit 0.']
        : [
            ...checkFailures.map((c) => `Check failed: ${c.command} (exit ${c.exit_code})`),
            ...failed.map((j) => `Journey ${j.id} ${j.passed === null ? 'not executed' : 'failed'}: ${j.failures.join('; ') || 'see evidence'}`),
          ],
      commands,
      journeys: journeyResults,
      tool_versions: {
        node: toolVersion(process.execPath, ['--version']),
        npm: toolVersion('npm', ['--version']),
        playwright: toolVersion(pwBin, ['--version'], gateDir),
        rijo_gate: 'deterministic codegen v2',
      },
      evidence_dir: evidenceDir,
      server_log: serverLogPath,
    };
  } finally {
    if (server && server.pid) {
      await stopServer(server, config.qa.shutdown_timeout_ms);
    }
    // remove the gate worktree; keep evidence (already copied out)
    spawnSync('git', ['worktree', 'remove', '--force', gateDir], { cwd: projectRoot, encoding: 'utf8' });
    fs.rmSync(gateDir, { recursive: true, force: true });
  }
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function stopServer(server: ReturnType<typeof spawn>, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    server.once('exit', finish);
    try {
      server.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      try {
        server.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      setTimeout(finish, 250);
    }, graceMs).unref();
  });
}

interface PlaywrightJsonReport {
  suites?: Array<PlaywrightSuite>;
  stats?: { expected?: number; unexpected?: number; skipped?: number };
}
interface PlaywrightSuite {
  title?: string;
  file?: string;
  suites?: PlaywrightSuite[];
  specs?: Array<{
    title?: string;
    ok?: boolean;
    file?: string;
    tests?: Array<{ projectName?: string; results?: Array<{ status?: string; error?: { message?: string } }> }>;
  }>;
}

function mapResults(
  journeys: Journey[],
  specs: Array<{ id: string; file: string }>,
  report: PlaywrightJsonReport,
): GateJourneyResult[] {
  const flat: Array<{ file: string; ok: boolean; errors: string[] }> = [];
  const walk = (suite: PlaywrightSuite) => {
    for (const s of suite.suites ?? []) walk(s);
    for (const spec of suite.specs ?? []) {
      const errors = (spec.tests ?? [])
        .flatMap((t) => t.results ?? [])
        .filter((r) => r.status !== 'passed')
        .map((r) => r.error?.message ?? 'failed')
        .map((m) => m.split('\n')[0]!.slice(0, 300));
      flat.push({ file: spec.file ?? suite.file ?? '', ok: spec.ok === true, errors });
    }
  };
  for (const s of report.suites ?? []) walk(s);

  return journeys.map((j) => {
    const spec = specs.find((s) => s.id === j.id) ?? null;
    if (!spec) {
      return { id: j.id, requirement_ids: j.requirement_ids, spec: null, passed: null, evidence: [], failures: ['no spec generated'] };
    }
    const base = path.basename(spec.file);
    const matches = flat.filter((f) => f.file.endsWith(base) || base.endsWith(path.basename(f.file)));
    if (matches.length === 0) {
      return { id: j.id, requirement_ids: j.requirement_ids, spec: spec.file, passed: null, evidence: [], failures: ['spec did not run'] };
    }
    const ok = matches.every((m) => m.ok);
    return {
      id: j.id,
      requirement_ids: j.requirement_ids,
      spec: spec.file,
      passed: ok,
      evidence: [],
      failures: ok ? [] : matches.flatMap((m) => m.errors),
    };
  });
}

function renderPlaywrightConfig(specDir: string, artifactsDir: string, resultsPath: string, config: RijoConfig): string {
  const projects = config.qa.browsers.flatMap((browser) =>
    config.qa.viewports.map(
      (vp) =>
        `    { name: ${JSON.stringify(`${browser}-${vp.name}`)}, use: { browserName: ${JSON.stringify(browser)}, viewport: { width: ${vp.width}, height: ${vp.height} } } }`,
    ),
  );
  return `// Generated by RIJO for the production gate (never committed to the target repo).
module.exports = {
  testDir: ${JSON.stringify(specDir)},
  outputDir: ${JSON.stringify(artifactsDir)},
  fullyParallel: false,
  retries: 0,
  reporter: [['json', { outputFile: ${JSON.stringify(resultsPath)} }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
${projects.join(',\n')}
  ],
};
`;
}
