# RIJO execution policy

Every command RIJO or an agent wants to run — a test, a build, `npm ci`, the
Playwright runner, the application under test — passes through two
independent gates before it executes. Neither gate can be bypassed by an
agent; both are pure functions over the raw command line and config, so their
decisions are deterministic and testable. Implemented in
`src/core/commands.ts` (string-level policy, `SystemShellRunner`) and
`src/security/execpolicy.ts` (capability-level policy, `planCommand`).

## Gate 1 — string-level command policy (`evaluateCommand`)

Runs first, before any classification. A command line is tokenized (simple
double-quote-aware split) and rejected outright if any of the following hold:

- **Shell metacharacters present** — `| & ; < > \` $ ( ) \n \r * ? ~ !`, `||`,
  `&&`, `>>`, `<<`. RIJO never invokes a shell (`spawnSync(..., {shell:
  false})`); there is no chaining, redirection, substitution, or globbing to
  reject in the first place, so any of these characters signals an attempt to
  reach one.
- **Executable not on the allowlist.** Only bare names are accepted:
  `npm`, `pnpm`, `yarn`, `bun`, `node`, `deno`, `tsc`, `vitest`, `jest`,
  `mocha`, `ava`, `playwright`, `eslint`, `prettier`, `biome`, `python`,
  `python3`, `pytest`, `ruff`, `mypy`, `go`, `cargo`, `make`. `npx`/`pnpx` are
  never in this list (see Gate 2). `git` is never in this list, by design —
  Git only happens through the typed `GitOps` layer, never through a
  free-form command an agent could compose.
- **Path-qualified executable** (`./x`, `/usr/bin/x`, `..`, backslash). The
  allowlist is by bare name only; a path-qualified invocation is a traversal
  attempt and is rejected regardless of what it resolves to.
- **Denied sub-command.** `npm`: `publish`, `unpublish`, `login`, `adduser`,
  `token`, `access`, `owner`, `deprecate`, `dist-tag`. `pnpm`/`yarn`/`bun`:
  `publish`, `login` (+`add-user` for pnpm). `cargo`: `publish`, `login`,
  `owner`, `yank`. These publish, authenticate, or mutate global/remote state
  — never legitimate verification actions.

A command that clears Gate 1 is categorized (`test`/`build`/`lint`/
`typecheck`/`format`/`package`/`audit`/`custom`) for reporting, but is not yet
approved to run.

## Gate 2 — capability policy (`planCommand`)

Decides **how** an accepted command may actually execute.

### npx/dlx — always blocked

`npx`, `pnpx`, `npm exec`/`npm x`, `pnpm dlx`, `yarn dlx`, `bun x` are refused
unconditionally with `disposition: BLOCKED`, regardless of config — they
download and execute arbitrary, unpinned registry packages. A locally
installed binary resolves through the reconstructed `PATH`
(`node_modules/.bin` is on it) instead.

### Trust classification

| Trust | Definition | Examples | Sandbox required? |
|---|---|---|---|
| `known-script` | Does NOT execute repository-controlled code | `npm audit`, `npm ping`, `npm --version`, `node --version` | No — runs `unsandboxed-trusted` |
| `repository-script` | Executes code from the project (or its dependencies) | `npm run <anything>`, `node x.js`, test runners, linters with executable configs, `npm ci`/`install` | Yes |

Everything not in the small fixed `known-script` table is
`repository-script` — the default assumption is "this runs arbitrary code."

### Network policy

| Value | Meaning |
|---|---|
| `none` (default) | No network. Seatbelt profile denies all network syscalls. |
| `restricted` | Loopback only — enough to run and talk to a local dev server under test, nothing beyond the machine. |
| `enabled` | Full network. Applied to `known-script` commands whose table entry says so (`npm audit`, `npm ping`), and unconditionally to installs. |

`config.execution.network_default` sets the default for `repository-script`
commands (`none` unless overridden); installs always get `enabled` regardless
of config, because a dependency install needs the registry.

### Environment reconstruction (`buildEnv`)

The child process never inherits `process.env` whole. It receives:

- `PATH` = workspace's own `node_modules/.bin` + the running Node's directory
  + the standard system bin dirs — nothing else;
- `HOME` and `TMPDIR` redirected to a scratch directory keyed by a hash of the
  cwd, created **outside** the workspace tree (system tmp) so the sandbox
  leaves no residue in the checkout and `~/.ssh`, `~/.aws`, cookies, and
  keychains simply do not resolve;
- `npm_config_yes=true`, `npm_config_update_notifier=false`,
  `npm_config_fund=false`, `npm_config_audit=false` (non-interactive,
  quiet installs);
- the base allowlist `LANG, LC_ALL, TERM, NODE_ENV, CI` plus whatever
  `config.execution.env_allowlist` adds — **except** any name that matches
  the secret-name pattern, which is dropped even if explicitly allowlisted:

  ```
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|PRIVATE|COOKIE|SESSION)
   |^(AWS_|GOOGLE_|AZURE_|GH_|GITHUB_|GITLAB_|NPM_|SSH_|OPENAI_|ANTHROPIC_)/i
  ```

### Sandbox decision (macOS Seatbelt)

`nativeSandboxAvailable()` is true only on `darwin` with
`/usr/bin/sandbox-exec` present. When available, `repository-script` commands
run wrapped in `sandbox-exec -p <profile>`, where the generated profile:

- denies `file-read*` under `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`,
  `~/.netrc`, and the literal `~/.npmrc`;
- denies all `file-write*` except inside the command's own `cwd` (resolved
  with `realpath`) and system tmp (`/private/tmp`, `/private/var/folders`);
- denies all network by default; `restricted` reopens loopback-only
  outbound/inbound/bind; `enabled` leaves network unrestricted.

`known-script` commands skip the sandbox entirely (`unsandboxed-trusted`).

### No sandbox available

| `execution.sandbox` config | Outcome |
|---|---|
| `required` (default) | `disposition: BLOCKED` — "no OS sandbox available on this host for repository code and execution.sandbox is 'required'; install a supported sandbox or set execution.sandbox: approved-unsandboxed (auditable opt-out)". The workflow stops. There is no unsafe fallback. |
| `approved-unsandboxed` | Runs with `sandbox: 'none-approved'` — an explicit, config-recorded opt-out, not a silent one. Every `CommandEvidence` for that run carries `sandbox: 'none-approved'` so the choice is auditable after the fact. |

### Install policy

Dependency installation (`install`/`ci`/`i`/`add`/`update`/`up` for
`npm`/`pnpm`/`yarn`/`bun`) is refused unless the caller passes
`allowInstall: true` explicitly — only `qa/gate.ts` sets it, to install the
locked tree of a checked-out commit. When permitted:

- `--ignore-scripts` is force-appended if not already present — lifecycle
  scripts (`postinstall`/`preinstall`/`install`) are arbitrary code running at
  install time and are always suppressed;
- network is forced to `enabled` (installs need the registry);
- the command still goes through the sandbox decision above like any other
  `repository-script`.

### cwd containment

`planCommand` resolves `opts.cwd` and refuses to run if it does not exist —
every command executes inside the attempt's own workspace or the gate's
checkout, never an arbitrary path.

## Evidence recorded

Every executed (or refused) command produces a `CommandEvidence`
(`core/commands.ts`):

```
{ command, exit_code, summary, duration_ms, blocked,
  category, sandbox, trust, network }
```

`blocked: true` (`exit_code: 126`) means the policy refused the command — this
is never treated as a repairable failure; workflows stop rather than looping
a worker on a forbidden command. `sandbox`/`trust`/`network` make the actual
execution conditions part of the permanent record (`VERIFICATION.md`,
readiness reports), not just the pass/fail result.

## Decision examples

| Command | Outcome | Why |
|---|---|---|
| `npm run test` | Runs sandboxed (Seatbelt on macOS) or `BLOCKED` elsewhere unless `approved-unsandboxed` | `repository-script`, network `none` by default |
| `npm audit` | Runs `unsandboxed-trusted`, network `enabled` | matches the `known-script` table |
| `npx create-react-app foo` | `BLOCKED` | npx always blocked |
| `npm install` (no `allowInstall`) | `BLOCKED` | install requires the explicit, gate-managed policy flag |
| `npm ci --ignore-scripts` (gate, `allowInstall: true`) | Runs sandboxed, network `enabled`, lifecycle scripts forced off | install path: `repository-script` trust, network forced `enabled` |
| `git push origin main` | Rejected at Gate 1 | `git` is not on the executable allowlist at all |
| `npm publish` | Rejected at Gate 1 | denied sub-command |
| `npm test \| tee log.txt` | Rejected at Gate 1 | shell metacharacter (`\|`) |
| `/usr/bin/npm test` | Rejected at Gate 1 | path-qualified executable |
| `node script.js` on Linux with `execution.sandbox: required` and no sandbox | `BLOCKED` | fail-closed: no unsandboxed fallback |
| same, with `execution.sandbox: approved-unsandboxed` | Runs `none-approved`, recorded in evidence | explicit, auditable opt-out |

Proven by `tests/hardening.test.ts` (`describe('command policy')`) and
`tests/sandbox.test.ts` (environment reconstruction, secret-name dropping,
`~/.ssh` denial, network denial by default, cwd-escape denial, symlink-escape
denial, lifecycle-script suppression on install — darwin-gated, self-skips on
other platforms).
