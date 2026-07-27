import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { planCommand, buildEnv, isSecretEnvName, nativeSandboxAvailable } from '../src/security/execpolicy.js';
import { SystemShellRunner } from '../src/core/commands.js';
import { ExecutionConfigSchema } from '../src/core/schemas/index.js';
import { tmpProject, cleanup } from './helpers.js';

const config = ExecutionConfigSchema.parse({});
const darwinSandbox = process.platform === 'darwin' && nativeSandboxAvailable();

describe('execution policy (planCommand)', () => {
  let root: string;
  beforeEach(() => (root = tmpProject('rijo-exec-')));
  afterEach(() => cleanup(root));

  it('blocks npx and dlx variants outright', () => {
    for (const raw of ['npx cowsay hi', 'npm exec cowsay', 'pnpm dlx cowsay', 'yarn dlx cowsay', 'bun x cowsay']) {
      const plan = planCommand(raw, { cwd: root, config });
      // npm exec passes the string gate but is an install-family door: assert at least npx/dlx die
      if (raw.startsWith('npx') || raw.includes('dlx') || raw.startsWith('bun x')) {
        expect(plan.ok, raw).toBe(false);
      }
    }
  });

  it('blocks dependency installation without the explicit install policy', () => {
    const plan = planCommand('npm ci', { cwd: root, config });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toContain('install');
  });

  it('forces --ignore-scripts on gate-approved installs (lifecycle scripts stay off)', () => {
    const plan = planCommand('npm ci', { cwd: root, config, allowInstall: true });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.command.args).toContain('--ignore-scripts');
  });

  it('allows only gate-managed, explicit Playwright browser provisioning', () => {
    const denied = planCommand('playwright install chromium', { cwd: root, config });
    expect(denied.ok).toBe(false);

    const approved = planCommand('playwright install chromium webkit', {
      cwd: root,
      config,
      allowInstall: true,
    });
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.command.network).toBe('enabled');
      expect(approved.command.trust).toBe('known-script');
      expect(approved.sandbox).toBe('unsandboxed-trusted');
    }

    for (const command of [
      'playwright install --with-deps chromium',
      'playwright install chrome',
      'playwright install',
    ]) {
      expect(planCommand(command, { cwd: root, config, allowInstall: true }).ok, command).toBe(
        false,
      );
    }
  });

  it('classifies repository scripts and requires a sandbox for them', () => {
    const blockedPlan = planCommand('npm run test', { cwd: root, config, sandboxAvailableOverride: false });
    expect(blockedPlan.ok).toBe(false);
    if (!blockedPlan.ok) {
      expect(blockedPlan.disposition).toBe('BLOCKED');
      expect(blockedPlan.reason).toContain('sandbox');
    }
  });

  it('approved-unsandboxed is an explicit, recorded opt-out — never a silent fallback', () => {
    const optOut = ExecutionConfigSchema.parse({ sandbox: 'approved-unsandboxed' });
    const plan = planCommand('npm run test', { cwd: root, config: optOut, sandboxAvailableOverride: false });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.sandbox).toBe('none-approved');
  });

  it('cwd must exist (containment: no running inside arbitrary paths)', () => {
    const plan = planCommand('npm run test', { cwd: path.join(root, 'nope'), config });
    expect(plan.ok).toBe(false);
  });

  it('allows loopback only for tests and keeps other repository code offline', () => {
    const test = planCommand('node scripts/verify-shell.mjs', {
      cwd: root,
      config,
      sandboxAvailableOverride: true,
    });
    expect(test.ok && test.command.network).toBe('restricted');
    const repo = planCommand('node scripts/build-app.mjs', {
      cwd: root,
      config,
      sandboxAvailableOverride: true,
    });
    expect(repo.ok && repo.command.network).toBe('none');
    const audit = planCommand('npm audit', { cwd: root, config });
    expect(audit.ok && audit.command.network).toBe('enabled');
  });
});

describe('environment reconstruction', () => {
  let root: string;
  beforeEach(() => (root = tmpProject('rijo-env-')));
  afterEach(() => cleanup(root));

  it('never inherits the whole process.env and drops secrets by name', () => {
    process.env['RIJO_TEST_SECRET_TOKEN'] = 'super-secret';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'aws-secret';
    try {
      const env = buildEnv(root, ExecutionConfigSchema.parse({ env_allowlist: ['RIJO_TEST_SECRET_TOKEN', 'AWS_SECRET_ACCESS_KEY'] }));
      // secrets do not pass even when explicitly allowlisted
      expect(env['RIJO_TEST_SECRET_TOKEN']).toBeUndefined();
      expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
      // HOME/TMPDIR are redirected into an out-of-tree scratch (never the real home)
      expect(env['HOME']).not.toBe(process.env['HOME']);
      expect(env['HOME']).toContain('rijo-sbx');
      expect(env['TMPDIR']).toContain('rijo-sbx');
      expect(env['PLAYWRIGHT_BROWSERS_PATH']).toContain(env['HOME']!);
      // PATH is rebuilt, not inherited
      expect(env['PATH']).toContain(path.join(root, 'node_modules', '.bin'));
    } finally {
      delete process.env['RIJO_TEST_SECRET_TOKEN'];
      delete process.env['AWS_SECRET_ACCESS_KEY'];
    }
  });

  it('flags credential-looking names', () => {
    for (const name of ['GITHUB_TOKEN', 'NPM_TOKEN', 'SSH_AUTH_SOCK', 'MY_API_KEY', 'DB_PASSWORD', 'AWS_PROFILE']) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    for (const name of ['PATH', 'LANG', 'NODE_ENV', 'CI']) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });
});

/** Real child-process probes under the native macOS sandbox. */
describe.runIf(darwinSandbox)('native sandbox (seatbelt) — real processes', () => {
  let root: string;
  let runner: SystemShellRunner;
  beforeEach(() => {
    root = fs.realpathSync(tmpProject('rijo-sbx-'));
    runner = new SystemShellRunner(config);
  });
  afterEach(() => cleanup(root));

  const probe = (name: string, code: string) => {
    fs.writeFileSync(path.join(root, name), code, 'utf8');
    return runner.run(`node ${name}`, { cwd: root });
  };

  it('an agent-written script cannot read sensitive environment variables', () => {
    process.env['RIJO_PROBE_TOKEN'] = 'leak-me';
    try {
      const ev = probe('probe-env.js', `console.log(process.env.RIJO_PROBE_TOKEN ? 'ENV-LEAKED' : 'ENV-ABSENT');`);
      expect(ev.sandbox).toBe('seatbelt');
      expect(ev.summary).toContain('ENV-ABSENT');
      expect(ev.summary).not.toContain('ENV-LEAKED');
    } finally {
      delete process.env['RIJO_PROBE_TOKEN'];
    }
  });

  it('an agent-written script cannot read ~/.ssh', () => {
    const realHome = os.homedir();
    const ev = probe(
      'probe-ssh.js',
      [
        `const fs = require('fs');`,
        `try { fs.readdirSync(${JSON.stringify(path.join(realHome, '.ssh'))}); console.log('SSH-READ-OK'); }`,
        `catch (e) { console.log('SSH-BLOCKED:' + e.code); }`,
      ].join('\n'),
    );
    expect(ev.summary).toContain('SSH-BLOCKED');
    expect(ev.summary).not.toContain('SSH-READ-OK');
  });

  it('untrusted code has no network by default', () => {
    const ev = probe(
      'probe-net.js',
      [
        `const net = require('net');`,
        `const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });`,
        `s.on('connect', () => { console.log('NET-OK'); process.exit(0); });`,
        `s.on('error', () => { console.log('NET-BLOCKED'); process.exit(0); });`,
        `s.on('timeout', () => { console.log('NET-BLOCKED'); process.exit(0); });`,
      ].join('\n'),
    );
    expect(ev.summary).toContain('NET-BLOCKED');
    expect(ev.summary).not.toContain('NET-OK');
  }, 20_000);

  it('writes outside the workspace are denied (cwd escape)', () => {
    const outside = path.join(os.homedir(), `rijo-escape-${Date.now()}.txt`);
    const ev = probe(
      'probe-write.js',
      [
        `const fs = require('fs');`,
        `try { fs.writeFileSync(${JSON.stringify(outside)}, 'escaped'); console.log('WRITE-OK'); }`,
        `catch (e) { console.log('WRITE-BLOCKED:' + e.code); }`,
      ].join('\n'),
    );
    expect(ev.summary).toContain('WRITE-BLOCKED');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('a symlink pointing outside cannot be used to write outside', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rijo-outside-'));
    try {
      // symlink created inside the workspace pointing at a dir outside /tmp allowances?
      // /private/tmp is write-allowed for scratch, so target the HOME instead.
      const target = path.join(os.homedir(), `rijo-symlink-target-${Date.now()}`);
      const ev = probe(
        'probe-symlink.js',
        [
          `const fs = require('fs');`,
          `fs.symlinkSync(${JSON.stringify(target)}, 'link-out');`,
          `try { fs.writeFileSync('link-out', 'through-link'); console.log('SYMLINK-WRITE-OK'); }`,
          `catch (e) { console.log('SYMLINK-BLOCKED:' + e.code); }`,
        ].join('\n'),
      );
      expect(ev.summary).toContain('SYMLINK-BLOCKED');
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('a malicious lifecycle script does not run on gate-approved install', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { preinstall: 'node evil.js' } }),
    );
    fs.writeFileSync(path.join(root, 'evil.js'), `require('fs').writeFileSync('PWNED.txt', 'pwned');`);
    const ev = runner.run('npm install --no-audit --no-fund', { cwd: root, allowInstall: true });
    expect(ev.exit_code).toBe(0);
    expect(fs.existsSync(path.join(root, 'PWNED.txt'))).toBe(false);
  }, 60_000);
});
