import { isSecretEnvName } from './execpolicy.js';

/**
 * Minimal environment for a HOST CLI child process (claude / codex).
 *
 * Handing `process.env` to a spawned host exports the operator's entire shell
 * environment — `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, database URLs, CI
 * secrets — into a process that runs a model with tool access. This module
 * reconstructs the environment from an explicit allowlist instead, exactly like
 * `execpolicy.buildEnv` does for repository commands, and reports the NAMES of
 * everything it withheld so the withholding is auditable without ever recording
 * a value.
 *
 * Trust boundary (deliberate): the host CLI itself is RIJO's runtime, so it DOES
 * receive `HOME` (the claude CLI keeps its credentials in `~/.claude`) and its
 * OWN authentication variables, enumerated per host below. What it does not
 * receive is every OTHER credential in the environment. The agent running inside
 * that CLI is a separate, untrusted layer and is fenced by the sensitive-path
 * deny rules (`hosts/claudeCli.ts`), by the workspace copy exclusions
 * (`security/sensitive.ts`), and by the sandboxed command policy
 * (`security/execpolicy.ts`) — which reconstructs its own, even smaller,
 * environment with a scratch HOME for anything the agent asks to execute.
 */

export interface HostEnvResult {
  /** The environment actually handed to the child. */
  env: Record<string, string>;
  /**
   * NAMES ONLY (sorted) of variables present in the source environment that were
   * NOT forwarded. Values are never captured, so this list is safe to log.
   */
  withheld: string[];
}

/**
 * Variables every host CLI legitimately needs: process bootstrap, locale,
 * terminal, temp dirs and proxy configuration. Nothing here carries a
 * credential; names that merely LOOK like credentials are dropped anyway by the
 * `isSecretEnvName` check below.
 */
export const HOST_ENV_BASE_ALLOWLIST: readonly string[] = [
  // process bootstrap
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  // temp directories
  'TMPDIR',
  'TMP',
  'TEMP',
  // locale / terminal
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'TZ',
  // Node runtime knobs that are configuration, not code injection.
  // NODE_OPTIONS is deliberately EXCLUDED: it can inject arbitrary --require
  // modules into the host process.
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
  'CI',
  // network egress configuration (the host CLI must reach its API)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  // Windows: `spawn` with a shell needs these to resolve anything at all
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/** Name prefixes forwarded wholesale (locale categories only). */
export const HOST_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_'];

/**
 * Authentication and endpoint variables the CLAUDE CLI needs for itself. These
 * are the only credential-shaped names that may cross into the host, and they
 * are enumerated — never matched by a `*_KEY` / `*_TOKEN` pattern.
 */
export const CLAUDE_HOST_ENV_ALLOWLIST: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

/** Authentication and endpoint variables the CODEX CLI needs for itself. */
export const CODEX_HOST_ENV_ALLOWLIST: readonly string[] = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
];

const CASE_INSENSITIVE = process.platform === 'win32';

function key(name: string): string {
  return CASE_INSENSITIVE ? name.toUpperCase() : name;
}

/**
 * Build the environment for a host CLI child. `hostAllowlist` carries the host's
 * OWN authentication variables (see the per-host constants above); everything
 * else must be in the base allowlist and must not look like a credential.
 *
 * Returns the env plus the names withheld. Never reads or copies a value that
 * is not forwarded, so `withheld` cannot leak one.
 */
export function buildHostEnv(
  hostAllowlist: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): HostEnvResult {
  const hostAllowed = new Set(hostAllowlist.map(key));
  const baseAllowed = new Set(HOST_ENV_BASE_ALLOWLIST.map(key));
  const prefixes = HOST_ENV_ALLOWED_PREFIXES.map(key);

  const env: Record<string, string> = {};
  const withheld: string[] = [];

  for (const name of Object.keys(source)) {
    const value = source[name];
    if (value === undefined) continue;
    const k = key(name);

    // The host's own auth: explicitly enumerated, so it passes even though the
    // name matches the credential pattern.
    if (hostAllowed.has(k)) {
      env[name] = value;
      continue;
    }
    const allowed = baseAllowed.has(k) || prefixes.some((p) => k.startsWith(p));
    // Defence in depth: a base-allowlisted name that still reads like a
    // credential (e.g. a shell exporting SSH_AUTH_SOCK) is withheld anyway.
    if (!allowed || isSecretEnvName(name)) {
      withheld.push(name);
      continue;
    }
    env[name] = value;
  }

  withheld.sort();
  return { env, withheld };
}
