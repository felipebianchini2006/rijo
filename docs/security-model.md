# RIJO security model

RIJO orchestrates LLM agents that read and write a real codebase and, for the
production gate, run a real server and a real browser. This document states
the threat model, the trust boundaries the implementation actually enforces,
and — as importantly — what is **not** guaranteed. It describes implemented
behavior only; nothing here is aspirational.

## Threat model

RIJO treats four actors/inputs as adversarial, in the specific sense that the
system must remain safe even when they behave worst-case:

### 1. A malicious, mistaken, or lying agent

An LLM agent (worker, planner, reviewer, researcher, qa) driven through
`AgentRunner` may, by design assumption or by failure, do any of:

- claim it edited only file A while it also touched file B;
- claim success (`done: true`) without having done the work;
- try to write outside its declared `write_scope`, including into `.rijo`
  canonical artifacts it was never granted;
- try to smuggle a `git push`, `git remote`, or a credential-reading command
  through a "verification command";
- loop indefinitely on a plan revision, a review cycle, or a repair attempt;
- introduce a symlink that resolves outside its own workspace.

RIJO never trusts the agent's own report of what it did. Every claim is
checked against something the core computed independently: a real filesystem
delta (`core/workspace.ts`), a real command exit code (`core/commands.ts`), or
a real diff range (`git diffNames`). See D11/D12 in `docs/architecture.md`.

### 2. Arbitrary code in the target repository

`npm run <script>`, `tsc`, test runners, linters with executable configs, and
the application under test in the production gate are all **repository
code** — code RIJO did not author and cannot vet. A compromised or malicious
dependency, a hostile lint plugin, or a booby-trapped npm script is assumed
possible. This class of command (`repository-script` trust, see
`docs/execution-policy.md`) always runs sandboxed when a sandbox is available,
and is refused outright (`BLOCKED`) rather than run unsandboxed when
`execution.sandbox: required` (the default) and no sandbox exists on the host.

### 3. Untrusted design input (`rijo ui`)

A `.zip`, a single file, or a directory handed to `rijo ui` is treated as
**untrusted input and a visual reference, not final architecture**. It may
contain path-traversal entries, symlinks, decompression bombs, executables,
or an `npm` lifecycle script (`postinstall`/`preinstall`/`install`). None of
it is ever executed; extraction only inspects and copies (`security/zip.ts`).

### 4. Supply-chain execution via `npx`/`dlx`/install lifecycle scripts

`npx <package>`, `pnpm dlx`, `yarn dlx`, `bun x`, and `npm exec`/`npm x` all
download and execute arbitrary, unpinned registry code. They are blocked
unconditionally, for every actor, everywhere in the codebase — there is no
code path that invokes them. Dependency installation (`npm ci`/`install`) is
the other supply-chain surface: it is refused unless a caller passes an
explicit `allowInstall` flag (only the production gate does, to install the
locked dependency tree of the checked-out commit) and lifecycle scripts are
always forced off with `--ignore-scripts`.

## Trust boundaries

| Boundary | Mechanism | Where |
|---|---|---|
| Worker writes | Per-attempt filesystem-copy workspace; real delta (not agent report) validated against the task's individual `write_scope` | `core/workspace.ts` |
| Canonical (`.rijo/**`) writes | Blocked unless the core explicitly grants a `canonicalWriteScope` for that one attempt (e.g. `SPEC.md`, `MAPPING.md`, QA screenshots) | `core/workspace.ts` (`CanonicalWriteError`) |
| Checkout application | Applied only after validation, atomically, with conflict detection against concurrent changes | `AttemptWorkspace.applyVerifiedPatch` |
| Command execution | Two-stage policy: string allowlist, then capability policy (trust/network/env/sandbox) | `core/commands.ts`, `security/execpolicy.ts` |
| Read-only agents | Planner/reviewer dispatch is checked post-hoc against a checkout snapshot; any modification blocks the phase | `workflows/shared.ts` (`dispatchReadOnly`) |
| Secrets in output | Pattern-based redaction applied to command summaries before they reach prompts, logs, or reports | `security/redact.ts` |
| Secrets in environment | Never inherited whole; dropped by NAME even if explicitly allowlisted in config | `security/execpolicy.ts` (`isSecretEnvName`) |
| Secrets on disk | `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.gnupg`, `~/.netrc`, `~/.npmrc` are unreadable inside the Seatbelt sandbox regardless of env redirection | `security/execpolicy.ts` (`seatbeltProfile`) |
| Design import | Guarded extraction (traversal/absolute-path/symlink/size/entry-count/expansion-ratio checks); nothing executed before inspection | `security/zip.ts` |
| UI import write scope | Derived from the agent's mapping payload, never `**`; forbidden destinations (`.rijo`, `.git`, `node_modules`, globs, path escapes) rejected before any write | `workflows/ui.ts` |
| Mock/placeholder leakage | Deterministic scan of the REAL changed files after conversion (never the agent's claim); a finding blocks the import before `applyVerifiedPatch` | `security/mockscan.ts` |
| Git operations | Only through the typed `GitOps` interface; `git` is absent from the shell allowlist so it can never be reached via a free-form command | `core/commands.ts`, `core/git.ts` |
| Canonical baseline | Every dispatched task carries a hash of the whole canonical context; a result is rejected if that context changed while the attempt ran (`CANONICAL_DRIFT`) | `core/manifest.ts` (`canonicalBaselineHash`), `workflows/run.ts` |

Proven by `tests/hardening.test.ts`, `tests/isolation.test.ts`,
`tests/workspace.test.ts`, `tests/sandbox.test.ts`, `tests/zip.test.ts`,
`tests/zip-dos.test.ts`, `tests/redact.test.ts`, `tests/ui-workflow.test.ts`.

## What is NOT guaranteed

Being explicit about the edges matters more than the list of protections.

- **No sandbox on Linux/Windows.** `nativeSandboxAvailable()` only recognizes
  macOS + `/usr/bin/sandbox-exec`. On other hosts, repository code either runs
  under the auditable `execution.sandbox: approved-unsandboxed` opt-out (no
  technical isolation — a config-recorded trust decision) or is `BLOCKED`.
  There is no Linux namespace/seccomp or Windows job-object sandbox
  implemented.
- **The Seatbelt profile is a best-effort deny-list**, not a formal proof of
  containment. It denies known-sensitive paths and non-loopback network by
  rule; it does not attempt to enumerate every possible exfiltration channel
  a determined process could use on macOS.
- **`known-script` commands run unsandboxed.** `npm audit`, `npm ping`,
  `--version` checks are trusted outright (`unsandboxed-trusted`) because they
  do not execute repository code — but that trust rests on npm's own binary
  and network layer, which RIJO does not vet.
- **Zip/directory import limits are heuristics**, not malware scanning: entry
  count, per-entry and total size ceilings, and an expansion-ratio bomb
  detector catch abusive archives, not semantically malicious-but-small
  content.
- **RIJO does not audit content it did not write.** If a user manually edits
  a canonical `.rijo/*.md` file to contain something false, the core reads
  and trusts that content like any other canonical file — the write-scope and
  workspace protections are about *who* changes canonical state, not about
  validating the semantic truth of state a human wrote directly.
- **The production gate exercises the target application's own code as
  intended** — that is the point of the gate. The application server runs
  under Seatbelt (loopback-only network, writes confined to the checkout),
  but the gate does not defend against the application itself being
  adversarial toward its own test harness beyond that containment.
- **No secrets-at-rest scanning.** Redaction (`security/redact.ts`) removes
  known secret *patterns* from command output before it is logged or shown to
  an agent; it does not scan the repository for secrets already committed
  before RIJO was introduced.
- **Command evidence trusts the local clock and process table** for staleness
  checks (lock freshness, cache TTL); it is not resistant to a host with a
  deliberately corrupted system clock.
- **Not all of this is exercised in CI.** `tests/sandbox.test.ts` and
  `tests/gate.e2e.test.ts` are gated on macOS + Seatbelt availability and
  self-skip on the `ubuntu-latest`/`windows-latest` CI matrix; the sandbox and
  production-gate guarantees above are verified locally on macOS or wherever
  a Seatbelt-capable runner executes them, not on every CI run. See
  `docs/production-readiness.md` for the exact limits.
