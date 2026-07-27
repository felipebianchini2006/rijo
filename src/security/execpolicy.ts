import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { evaluateCommand, type CommandCategory } from '../core/commands.js';
import type { ExecutionConfig } from '../core/schemas/index.js';

/**
 * Capability-based execution policy. The string-level allowlist in
 * core/commands is only the FIRST gate; this module decides how a command may
 * actually run: trust level, network access, reconstructed environment, cwd
 * containment and OS sandbox. Repository scripts are arbitrary code — they
 * only run inside a sandbox (or with an explicit, auditable opt-out).
 */

export type CommandTrust = 'known-script' | 'repository-script' | 'custom';
export type NetworkPolicy = 'none' | 'restricted' | 'enabled';

export interface ExecutableCommand {
  executable: string;
  args: string[];
  cwd: string;
  category: CommandCategory;
  trust: CommandTrust;
  network: NetworkPolicy;
  envAllowlist: string[];
  timeoutMs: number;
}

export type SandboxKind = 'seatbelt' | 'none-approved' | 'unsandboxed-trusted';

export interface CommandPlan {
  ok: true;
  command: ExecutableCommand;
  sandbox: SandboxKind;
  /** environment actually passed to the child — reconstructed, never inherited whole */
  env: Record<string, string>;
  /** concrete spawn invocation (sandbox wrapper included when applicable) */
  spawn: { executable: string; args: string[] };
}

export interface CommandRefusal {
  ok: false;
  reason: string;
  /** BLOCKED means "do not fall back"; the workflow must stop, never run unsandboxed. */
  disposition: 'BLOCKED';
}

export interface PlanCommandOptions {
  /** the attempt workspace (or gate checkout) the command must stay inside */
  cwd: string;
  config: ExecutionConfig;
  /** dependency installation requires this explicit policy flag */
  allowInstall?: boolean;
  /** test seam: force the sandbox-availability answer */
  sandboxAvailableOverride?: boolean;
}

/**
 * Commands that do NOT execute repository-controlled code. Everything else —
 * `npm run x`, `node x.js`, test runners, linters with executable configs —
 * runs arbitrary repository code and is `repository-script`.
 */
const KNOWN_SCRIPT: Array<{ exe: string; sub?: string; network: NetworkPolicy }> = [
  { exe: 'npm', sub: 'audit', network: 'enabled' },
  { exe: 'npm', sub: 'ping', network: 'enabled' },
  { exe: 'npm', sub: '--version', network: 'none' },
  { exe: 'node', sub: '--version', network: 'none' },
];

const INSTALL_SUBCOMMANDS = new Set(['install', 'ci', 'i', 'add', 'update', 'up']);

/** Env vars whose NAMES look like credentials — never forwarded, even via PATH-style lists. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|PRIVATE|COOKIE|SESSION)|^(AWS_|GOOGLE_|AZURE_|GH_|GITHUB_|GITLAB_|NPM_|SSH_|OPENAI_|ANTHROPIC_)/i;

/** Base variables reconstructed for every child. */
const BASE_ALLOWLIST = ['LANG', 'LC_ALL', 'TERM', 'NODE_ENV', 'CI'];

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** True when this host offers a native OS sandbox RIJO knows how to drive. */
export function nativeSandboxAvailable(): boolean {
  return process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
}

function classify(executable: string, args: string[]): { trust: CommandTrust; network: NetworkPolicy } {
  const sub = args.find((a) => !a.startsWith('-')) ?? args[0] ?? '';
  const known = KNOWN_SCRIPT.find((k) => k.exe === executable && (k.sub === undefined || k.sub === sub || args[0] === k.sub));
  if (known) return { trust: 'known-script', network: known.network };
  return { trust: 'repository-script', network: 'none' };
}

/**
 * Build the reconstructed child environment. PATH points at the workspace's
 * own node_modules/.bin plus the system tool dirs and the running Node's dir;
 * HOME and TMPDIR are redirected into a scratch dir inside the workspace so
 * `~/.ssh`, `~/.aws`, cookies and keychains simply do not resolve. Secrets
 * never pass, not even when someone lists them in env_allowlist.
 */
export function buildEnv(cwd: string, config: ExecutionConfig): Record<string, string> {
  // scratch HOME/TMPDIR live OUTSIDE the workspace tree (system tmp) so the
  // sandbox leaves no residue in the checkout — a clean tree stays clean.
  const digest = createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12);
  const scratchHome = path.join(os.tmpdir(), 'rijo-sbx', digest);
  fs.mkdirSync(path.join(scratchHome, 'tmp'), { recursive: true });
  const nodeDir = path.dirname(process.execPath);
  const env: Record<string, string> = {
    PATH: [path.join(cwd, 'node_modules', '.bin'), nodeDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'].join(
      path.delimiter,
    ),
    HOME: scratchHome,
    TMPDIR: path.join(scratchHome, 'tmp'),
    PLAYWRIGHT_BROWSERS_PATH: path.join(scratchHome, 'ms-playwright'),
    npm_config_yes: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
  for (const name of [...BASE_ALLOWLIST, ...config.env_allowlist]) {
    if (isSecretEnvName(name)) continue; // secrets never pass, allowlisted or not
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** macOS Seatbelt profile: deny network unless enabled; writes only inside the workspace + scratch. */
export function seatbeltProfile(cwd: string, network: NetworkPolicy): string {
  const home = os.homedir();
  const lines = [
    '(version 1)',
    '(allow default)',
    // secrets on disk: unreadable regardless of env redirection
    `(deny file-read* (subpath "${home}/.ssh"))`,
    `(deny file-read* (subpath "${home}/.aws"))`,
    `(deny file-read* (subpath "${home}/.config/gh"))`,
    `(deny file-read* (subpath "${home}/.gnupg"))`,
    `(deny file-read* (subpath "${home}/.netrc"))`,
    `(deny file-read* (literal "${home}/.npmrc"))`,
    // writes: nothing outside the workspace (rules later in the profile win)
    '(deny file-write*)',
    `(allow file-write* (subpath "${fs.realpathSync(cwd)}"))`,
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))',
  ];
  if (network !== 'enabled') {
    lines.push('(deny network*)');
    // "restricted": loopback only — enough to run and talk to a local dev
    // server under test, nothing beyond the machine.
    if (network === 'restricted') {
      lines.push('(allow network-outbound (remote ip "localhost:*"))');
      lines.push('(allow network-bind (local ip "localhost:*"))');
      lines.push('(allow network-inbound (local ip "localhost:*"))');
    }
  }
  return lines.join('\n');
}

/**
 * Decide how (and whether) a raw command line may run. Refusals carry
 * disposition BLOCKED: the caller stops the workflow — there is no unsafe
 * fallback path.
 */
export function planCommand(raw: string, opts: PlanCommandOptions): CommandPlan | CommandRefusal {
  const decision = evaluateCommand(raw);
  if (!decision.ok) {
    return { ok: false, reason: `command policy: ${decision.reason}`, disposition: 'BLOCKED' };
  }
  const { executable, args, category } = decision;

  // npx downloads and executes arbitrary registry packages — never allowed.
  if (
    executable === 'npx' ||
    executable === 'pnpx' ||
    (executable === 'npm' && (args[0] === 'exec' || args[0] === 'x')) ||
    (executable === 'pnpm' && args[0] === 'dlx') ||
    (executable === 'yarn' && args[0] === 'dlx') ||
    (executable === 'bun' && args[0] === 'x')
  ) {
    return {
      ok: false,
      reason: 'npx/dlx can download and execute arbitrary packages; invoke the locally installed binary (node_modules/.bin is on PATH) instead',
      disposition: 'BLOCKED',
    };
  }

  // Dependency installation and Playwright's browser provisioning need the
  // explicit gate policy. The latter is deliberately limited to the three
  // browser families supported by Playwright; flags and arbitrary download
  // targets remain unavailable to agents.
  const sub = args.find((a) => !a.startsWith('-')) ?? '';
  const isPackageInstall =
    ['npm', 'pnpm', 'yarn', 'bun'].includes(executable) && INSTALL_SUBCOMMANDS.has(sub);
  const browserTargets = args.slice(1);
  const isBrowserInstall =
    executable === 'playwright' &&
    args[0] === 'install' &&
    browserTargets.length > 0 &&
    browserTargets.every((browser) => ['chromium', 'firefox', 'webkit'].includes(browser));
  const attemptedBrowserInstall = executable === 'playwright' && args[0] === 'install';
  if (attemptedBrowserInstall && !isBrowserInstall) {
    return {
      ok: false,
      reason:
        'Playwright browser provisioning only accepts explicit chromium, firefox, or webkit targets without flags',
      disposition: 'BLOCKED',
    };
  }
  const isManagedInstall = isPackageInstall || isBrowserInstall;
  if (isManagedInstall && !opts.allowInstall) {
    return {
      ok: false,
      reason: `installation ("${executable} ${sub}") requires the explicit install policy (gate-managed); agents cannot install packages or browsers`,
      disposition: 'BLOCKED',
    };
  }

  // cwd must stay inside the attempt workspace / gate checkout
  const resolvedCwd = path.resolve(opts.cwd);
  if (!fs.existsSync(resolvedCwd)) {
    return { ok: false, reason: `cwd does not exist: ${resolvedCwd}`, disposition: 'BLOCKED' };
  }

  const classified = classify(executable, args);
  // A gate-approved package install runs with --ignore-scripts (appended
  // below). A browser install executes only Playwright's version-pinned
  // downloader with schema-constrained targets. Both need network access and
  // work identically on hosts without an OS sandbox.
  const trust: CommandTrust = isManagedInstall ? 'known-script' : classified.trust;
  const effectiveNetwork: NetworkPolicy = isManagedInstall
    ? 'enabled'
    : trust === 'known-script'
      ? classified.network
      : category === 'test' && opts.config.network_default === 'none'
        ? 'restricted'
        : opts.config.network_default;

  let finalArgs = args;
  if (isPackageInstall) {
    // lifecycle scripts are arbitrary code running at install time: always off
    if (!finalArgs.includes('--ignore-scripts')) finalArgs = [...finalArgs, '--ignore-scripts'];
  }

  const command: ExecutableCommand = {
    executable,
    args: finalArgs,
    cwd: resolvedCwd,
    category,
    trust,
    network: effectiveNetwork,
    envAllowlist: [...BASE_ALLOWLIST, ...opts.config.env_allowlist.filter((n) => !isSecretEnvName(n))],
    timeoutMs: opts.config.command_timeout_ms,
  };
  const env = buildEnv(resolvedCwd, opts.config);

  // sandbox decision: repository code demands one
  if (trust === 'known-script') {
    return { ok: true, command, sandbox: 'unsandboxed-trusted', env, spawn: { executable, args: finalArgs } };
  }
  if (opts.sandboxAvailableOverride ?? nativeSandboxAvailable()) {
    const profile = seatbeltProfile(resolvedCwd, effectiveNetwork);
    return {
      ok: true,
      command,
      sandbox: 'seatbelt',
      env,
      spawn: { executable: '/usr/bin/sandbox-exec', args: ['-p', profile, executable, ...finalArgs] },
    };
  }
  if (opts.config.sandbox === 'approved-unsandboxed') {
    return { ok: true, command, sandbox: 'none-approved', env, spawn: { executable, args: finalArgs } };
  }
  return {
    ok: false,
    reason:
      'no OS sandbox available on this host for repository code and execution.sandbox is "required"; ' +
      'install a supported sandbox or set execution.sandbox: approved-unsandboxed (auditable opt-out)',
    disposition: 'BLOCKED',
  };
}
