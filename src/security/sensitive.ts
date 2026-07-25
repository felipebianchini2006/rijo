/**
 * Canonical list of repository paths that must NEVER be copied into an agent
 * workspace (and therefore never appear in a workspace snapshot or delta).
 *
 * An attempt workspace is an isolated COPY of the controlled checkout. Without
 * this list the copy would faithfully reproduce every credential the developer
 * happens to keep in the project: `.env` files, npm/PyPI auth tokens, private
 * keys, and the local Claude/Codex configuration (MCP server credentials, hook
 * scripts, plugin settings). A host CLI running inside that copy could then read
 * them even though it never touched the real checkout — the deny rules in
 * `hosts/claudeCli.ts` are the second gate, this exclusion is the first: what is
 * never copied cannot be read, cannot be leaked through a diff, and cannot be
 * written back by `applyVerifiedPatch`.
 *
 * Scope note: this covers project-local credential material. Home-directory
 * stores (`~/.ssh`, `~/.aws`, …) are outside any workspace by construction and
 * are handled by the host deny rules and the Seatbelt profile in
 * `security/execpolicy.ts`; the corresponding names are listed here too so a
 * checked-in copy of one (a `.ssh/` directory inside the project) is excluded as
 * well.
 */

/**
 * Glob patterns, relative to a project root, using forward slashes.
 * `**` matches any number of path segments, `*` matches within one segment.
 * A leading double-star segment therefore also matches at the root itself.
 */
export const SENSITIVE_PATH_PATTERNS: readonly string[] = [
  // dotenv files at any depth (.env, .env.local, .env.production, …)
  '**/.env',
  '**/.env.*',
  // package / language-ecosystem credential files
  '**/.npmrc',
  '**/.yarnrc.yml',
  '**/.netrc',
  '**/_netrc',
  '**/.pypirc',
  '**/.pgpass',
  '**/.dockercfg',
  '**/.docker/config.json',
  // private keys, certificates and key stores
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  // MCP server definitions — carry server credentials and command lines
  '**/.mcp.json',
  // local Claude Code configuration: credentials, settings, hooks, plugins
  '**/.claude.json',
  '**/.claude.json.*',
  '**/.claude/settings.json',
  '**/.claude/settings.*.json',
  '**/.claude/.credentials.json',
  '**/.claude/hooks/**',
  '**/.claude/plugins/**',
  // local Codex configuration (auth.json, config.toml, …)
  '**/.codex/**',
  // checked-in copies of home-directory credential stores
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.config/gh/**',
];

/** Translate one of the patterns above into an anchored regular expression. */
function compile(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled && pattern[i + 2] === '/') {
        // `**/` — any number of leading segments, including none.
        out += '(?:[^/]+/)*';
        i += 2;
      } else if (doubled) {
        // trailing `**` — everything below this point.
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const COMPILED: readonly RegExp[] = SENSITIVE_PATH_PATTERNS.map(compile);

/**
 * True when a project-relative path names credential material that must never
 * enter an agent workspace. `rel` is relative to the project root; Windows
 * separators and a leading `./` are normalized away. Absolute paths and paths
 * escaping the root are rejected (treated as sensitive) — a caller that cannot
 * express a path relative to the root gets the safe answer.
 */
export function isSensitivePath(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '') return false;
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return true;
  if (normalized === '..' || normalized.startsWith('../')) return true;
  return COMPILED.some((re) => re.test(normalized));
}
