import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RijoPaths } from '../src/core/paths.js';
import { AgentTaskSchema, type AgentTask } from '../src/agents/protocol.js';
import { ConfigSchema, SupervisorConfigSchema, type SupervisorConfig } from '../src/core/schemas/index.js';
import { AttemptWorkspace } from '../src/core/workspace.js';
import { isSensitivePath, SENSITIVE_PATH_PATTERNS } from '../src/security/sensitive.js';
import {
  buildHostEnv,
  CLAUDE_HOST_ENV_ALLOWLIST,
  CODEX_HOST_ENV_ALLOWLIST,
} from '../src/security/hostEnv.js';
import { buildClaudeLaunch } from '../src/hosts/claudeCli.js';
import { buildCodexLaunch } from '../src/hosts/codexCli.js';
import { Supervisor, SystemClock, ProcessController, TaskStore, type RawExit } from '../src/supervisor/index.js';

/**
 * Credential fence (blocker 3). Two independent leaks are proven closed with
 * REAL artefacts — a real workspace copy on disk and a real child process:
 *
 *   1. an attempt workspace is a copy of the checkout, so any credential the
 *      developer keeps in the project would be copied in verbatim;
 *   2. a host CLI used to be spawned with `process.env`, exporting the whole
 *      operator environment (cloud keys, registry tokens, database passwords)
 *      into a process that runs a model with tool access.
 *
 * Nothing here is mocked: the workspace is created by AttemptWorkspace and
 * inspected by walking the filesystem; the environment is read back from a real
 * `node` child's own `process.env`.
 */

/** Fake credential VALUES. None of these may appear anywhere but the fixture. */
const FAKE = {
  env: 'rijo-fake-dotenv-value-AAA',
  envLocal: 'rijo-fake-dotenv-local-BBB',
  npmToken: 'rijo-fake-npm-token-CCC',
  pem: 'rijo-fake-private-key-DDD',
  mcp: 'rijo-fake-mcp-credential-EEE',
  claudeSettings: 'rijo-fake-claude-settings-FFF',
  hook: 'rijo-fake-hook-body-GGG',
  codexAuth: 'rijo-fake-codex-auth-HHH',
  claudeJson: 'rijo-fake-claude-json-III',
  netrc: 'rijo-fake-netrc-JJJ',
};

/** Fake credential ENV VARS exported into the test process before each spawn. */
const LEAKY_ENV: Record<string, string> = {
  FAKE_SECRET: 'rijo-fake-env-secret-111',
  AWS_SECRET_ACCESS_KEY: 'rijo-fake-aws-222',
  GITHUB_TOKEN: 'rijo-fake-gh-333',
  MY_DATABASE_PASSWORD: 'rijo-fake-db-444',
  NPM_TOKEN: 'rijo-fake-npm-555',
};

const SENSITIVE_FIXTURE_FILES: ReadonlyArray<[string, string]> = [
  ['.env', `FAKE_SECRET=${FAKE.env}\n`],
  ['.env.local', `FAKE_LOCAL=${FAKE.envLocal}\n`],
  ['.npmrc', `//registry.npmjs.org/:_authToken=${FAKE.npmToken}\n`],
  ['.netrc', `machine example.com password ${FAKE.netrc}\n`],
  ['keys/id_rsa.pem', `-----BEGIN PRIVATE KEY-----\n${FAKE.pem}\n`],
  ['keys/server.key', `-----BEGIN PRIVATE KEY-----\n${FAKE.pem}\n`],
  ['.mcp.json', JSON.stringify({ mcpServers: { db: { env: { TOKEN: FAKE.mcp } } } })],
  ['.claude.json', JSON.stringify({ oauthAccount: FAKE.claudeJson })],
  ['.claude/settings.json', JSON.stringify({ apiKeyHelper: FAKE.claudeSettings })],
  ['.claude/settings.local.json', JSON.stringify({ apiKeyHelper: FAKE.claudeSettings })],
  ['.claude/hooks/pre-tool.sh', `#!/bin/sh\necho ${FAKE.hook}\n`],
  ['.codex/auth.json', JSON.stringify({ token: FAKE.codexAuth })],
  ['src/nested/.env', `NESTED=${FAKE.env}\n`],
];

/** Ordinary project files that MUST survive the copy. */
const HARMLESS_FIXTURE_FILES: ReadonlyArray<[string, string]> = [
  ['src/app.ts', 'export const app = 1;\n'],
  ['README.md', '# fixture\n'],
  ['config/settings.json', '{"theme":"dark"}\n'],
  ['docs/env.md', 'How to fill in your .env file.\n'],
];

const unhandled: unknown[] = [];
const allPids: number[] = [];
let scriptDir: string;

/** Child that reports its OWN environment back as the agent result payload. */
const ENV_PROBE = `process.stdout.write(JSON.stringify({ summary: 'env-probe', env: process.env }) + '\\n', () => process.exit(0));`;

beforeAll(() => {
  process.on('unhandledRejection', (r) => unhandled.push(r));
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-credfence-'));
  fs.writeFileSync(path.join(scriptDir, 'env-probe.mjs'), ENV_PROBE, 'utf8');
});

afterEach(() => {
  expect(unhandled).toEqual([]);
  for (const name of Object.keys(LEAKY_ENV)) delete process.env[name];
});

afterAll(() => {
  const survivors = allPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  expect(survivors).toEqual([]);
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

function makeFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-credproj-'));
  for (const [rel, body] of [...SENSITIVE_FIXTURE_FILES, ...HARMLESS_FIXTURE_FILES]) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  }
  return root;
}

/** Every regular file under `root`, as project-relative forward-slash paths. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out;
}

function exportLeakyEnv(): void {
  for (const [name, value] of Object.entries(LEAKY_ENV)) process.env[name] = value;
}

describe('isSensitivePath (canonical exclusion list)', () => {
  it('matches credential material at the root and at any depth', () => {
    const sensitive = [
      '.env',
      '.env.local',
      '.env.production',
      'services/api/.env',
      '.npmrc',
      'packages/web/.npmrc',
      '.netrc',
      '.pypirc',
      'keys/id_rsa',
      'keys/id_rsa.pem',
      'certs/server.key',
      'certs/bundle.p12',
      'certs/bundle.pfx',
      '.mcp.json',
      '.claude.json',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/hooks/pre-tool.sh',
      '.claude/plugins/x/plugin.json',
      '.codex/auth.json',
      '.codex/config.toml',
      '.ssh/known_hosts',
      '.aws/credentials',
    ];
    for (const rel of sensitive) expect(isSensitivePath(rel), rel).toBe(true);
  });

  it('leaves ordinary project files alone', () => {
    const harmless = [
      'src/app.ts',
      'README.md',
      'docs/env.md',
      'config/settings.json',
      '.claude/agents/reviewer.md',
      'src/environment.ts',
      'src/keyboard.ts',
      'test/fixtures/envelope.json',
    ];
    for (const rel of harmless) expect(isSensitivePath(rel), rel).toBe(false);
  });

  it('normalizes Windows separators and refuses to answer "safe" for escaping paths', () => {
    expect(isSensitivePath('packages\\web\\.env')).toBe(true);
    expect(isSensitivePath('./.npmrc')).toBe(true);
    expect(isSensitivePath('../outside/file.ts')).toBe(true);
    expect(isSensitivePath('/etc/passwd')).toBe(true);
  });

  it('publishes the patterns it enforces', () => {
    expect(SENSITIVE_PATH_PATTERNS).toContain('**/.env');
    expect(SENSITIVE_PATH_PATTERNS).toContain('**/.codex/**');
    expect(SENSITIVE_PATH_PATTERNS).toContain('**/.claude/hooks/**');
  });
});

describe('attempt workspace never receives credentials (real copy on disk)', () => {
  it('excludes every sensitive fixture file and none of their values reach the copy', () => {
    const projectRoot = makeFixtureProject();
    try {
      const ws = AttemptWorkspace.create(projectRoot, { taskId: 'T-cred', writeScope: ['src/'] });
      const copied = listFiles(ws.root);

      // 1. not one sensitive path was copied
      for (const [rel] of SENSITIVE_FIXTURE_FILES) {
        expect(copied, rel).not.toContain(rel);
        expect(fs.existsSync(path.join(ws.root, rel)), rel).toBe(false);
      }
      // 2. the ordinary project IS there — the exclusion is surgical, not a
      //    refusal to copy the project
      for (const [rel] of HARMLESS_FIXTURE_FILES) expect(copied, rel).toContain(rel);

      // 3. no credential VALUE appears anywhere inside the workspace
      const blob = copied.map((rel) => fs.readFileSync(path.join(ws.root, rel), 'utf8')).join('\n');
      for (const [label, value] of Object.entries(FAKE)) {
        expect(blob.includes(value), `${label} leaked into the workspace`).toBe(false);
      }

      // 4. the excluded files are invisible to the delta too, so an attempt can
      //    neither report them nor push them back into the checkout
      expect(ws.collectDelta().changed).toEqual([]);
      ws.discard();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('an agent that writes a credential file inside the workspace cannot push it back', () => {
    const projectRoot = makeFixtureProject();
    try {
      const ws = AttemptWorkspace.create(projectRoot, { taskId: 'T-cred2', writeScope: ['src/'] });
      fs.writeFileSync(path.join(ws.root, '.env'), 'STOLEN=rijo-fake-exfiltration\n', 'utf8');
      fs.writeFileSync(path.join(ws.root, 'src', 'app.ts'), 'export const app = 2;\n', 'utf8');

      const delta = ws.validate();
      expect(delta.changed).toEqual(['src/app.ts']);
      ws.applyVerifiedPatch();
      // the checkout's own .env is untouched — the workspace copy never had it
      expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).toContain(FAKE.env);
      expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf8')).not.toContain('STOLEN');
      ws.discard();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('buildHostEnv (allowlist, not inheritance)', () => {
  it('withholds credential-shaped variables and reports their NAMES only', () => {
    const source = { ...LEAKY_ENV, PATH: '/usr/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8', LC_TIME: 'C' };
    const { env, withheld } = buildHostEnv([], source);
    for (const name of Object.keys(LEAKY_ENV)) {
      expect(env[name], name).toBeUndefined();
      expect(withheld, name).toContain(name);
    }
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/dev');
    expect(env['LANG']).toBe('en_US.UTF-8');
    expect(env['LC_TIME']).toBe('C');
    // the report carries names, never values
    expect(withheld.join('|')).not.toContain('rijo-fake');
  });

  it('withholds NODE_OPTIONS (arbitrary --require injection) and SSH_AUTH_SOCK', () => {
    const { env, withheld } = buildHostEnv([], {
      PATH: '/usr/bin',
      NODE_OPTIONS: '--require /tmp/evil.js',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    });
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(withheld).toEqual(expect.arrayContaining(['NODE_OPTIONS', 'SSH_AUTH_SOCK']));
  });

  it("forwards a host's OWN auth variables and nobody else's", () => {
    const source = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: 'openai-key',
      STRIPE_SECRET_KEY: 'stripe-key',
    };
    const claude = buildHostEnv(CLAUDE_HOST_ENV_ALLOWLIST, source).env;
    expect(claude['ANTHROPIC_API_KEY']).toBe('anthropic-key');
    expect(claude['OPENAI_API_KEY']).toBeUndefined();
    expect(claude['STRIPE_SECRET_KEY']).toBeUndefined();

    const codex = buildHostEnv(CODEX_HOST_ENV_ALLOWLIST, source).env;
    expect(codex['OPENAI_API_KEY']).toBe('openai-key');
    expect(codex['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(codex['STRIPE_SECRET_KEY']).toBeUndefined();
  });
});

describe('host launch builders produce an explicit, minimal env', () => {
  const CONFIG = ConfigSchema.parse({});
  const task = (): AgentTask =>
    AgentTaskSchema.parse({
      id: 'T-envfence',
      role: 'worker',
      objective: 'build something',
      return_format: 'JSON',
      write_scope: ['src/'],
      workspace: { id: 'ws-1', root: '/tmp/rijo-ws-envfence' },
    });

  it('buildClaudeLaunch / buildCodexLaunch never export the operator environment', () => {
    exportLeakyEnv();
    for (const build of [buildClaudeLaunch, buildCodexLaunch]) {
      const launch = build(task(), CONFIG, { projectRoot: '/proj' });
      expect(launch.env, 'launch must carry an explicit env').toBeDefined();
      for (const [name, value] of Object.entries(LEAKY_ENV)) {
        expect(launch.env![name], name).toBeUndefined();
        expect(launch.envWithheld, name).toContain(name);
        expect(JSON.stringify(launch.env)).not.toContain(value);
      }
      // the host still gets what it needs to run and to find its credentials
      expect(launch.env!['PATH']).toBeDefined();
      expect(launch.env!['HOME']).toBe(process.env['HOME']);
    }
  });
});

/** Result parser that surfaces the child's reported environment as the payload. */
function parseResult(task: AgentTask, exit: RawExit) {
  const line = exit.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  let payload: unknown = null;
  try {
    payload = JSON.parse(line);
  } catch {
    /* non-JSON output */
  }
  return {
    task_id: task.id,
    ok: exit.code === 0,
    summary: (payload as { summary?: string } | null)?.summary ?? `exit ${exit.code ?? 'null'}`,
    files_written: [],
    payload,
    scope_requests: [],
    attempt_id: null,
    generation: null,
    lease_id: null,
  };
}

function cfg(): SupervisorConfig {
  return SupervisorConfigSchema.parse({
    heartbeat_interval_ms: 50,
    heartbeat_grace_ms: 200,
    cancel_grace_ms: 1_000,
    hard_kill_grace_ms: 1_000,
    hard_timeout_ms: { worker: 20_000 },
    no_progress_timeout_ms: { worker: 20_000 },
    max_replacements_per_task: 0,
    replacement_backoff_ms: [10],
    max_total_task_elapsed_ms: 60_000,
  });
}

describe('ProcessController spawns hosts with a reconstructed environment (real child)', () => {
  it('the child cannot see the operator secrets, and the withheld NAMES are audited without values', async () => {
    exportLeakyEnv();
    const paths = new RijoPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-credsup-')));
    const controller = new ProcessController(
      {
        buildCommand: () => ({
          command: process.execPath,
          args: [path.join(scriptDir, 'env-probe.mjs')],
          cwd: scriptDir,
        }),
        parseResult,
        onSpawn: (pid) => {
          if (pid != null) allPids.push(pid);
        },
      },
      'env-probe-host',
    );
    const supervisor = new Supervisor({ controller, config: cfg(), paths, clock: new SystemClock() });
    const task = AgentTaskSchema.parse({
      id: 'envfence-T01',
      role: 'worker',
      objective: 'report my environment',
      return_format: 'JSON',
      workspace: { id: 'ws-envfence-g1', root: scriptDir },
    });

    const result = await supervisor.superviseTask(task);
    expect(result.ok).toBe(true);

    // (b) the REAL child environment, read back from the child itself
    const childEnv = (result.payload as { env?: Record<string, string> }).env ?? {};
    for (const name of Object.keys(LEAKY_ENV)) {
      expect(childEnv[name], `${name} leaked into the host process`).toBeUndefined();
    }
    expect(childEnv['PATH'], 'the host still needs PATH').toBeDefined();

    // the withheld NAMES are recorded — names only, never values
    const store = new TaskStore(paths);
    const filtered = store.readEvents('envfence-T01').filter((e) => e.type === 'host_env_filtered');
    expect(filtered.length).toBe(1);
    const names = filtered[0]!.data['withheld_names'] as string[];
    expect(names).toEqual(expect.arrayContaining(Object.keys(LEAKY_ENV)));

    // (c) nothing that was written down anywhere carries a secret VALUE
    const eventsBlob = fs.readFileSync(store.eventsFile, 'utf8');
    const recordBlob = fs.readFileSync(path.join(store.tasksDir, 'envfence-T01.json'), 'utf8');
    const resultBlob = JSON.stringify(result);
    for (const [name, value] of Object.entries(LEAKY_ENV)) {
      expect(eventsBlob.includes(value), `${name} value leaked into task events`).toBe(false);
      expect(recordBlob.includes(value), `${name} value leaked into the task record`).toBe(false);
      expect(resultBlob.includes(value), `${name} value leaked into the agent result`).toBe(false);
    }
  }, 30_000);
});
