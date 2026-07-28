# Security policy

## Operational security rules (enforced in code)

- **Secrets** are never printed in prompts, logs or reports. All shell output
  destined for evidence/summaries passes through `src/security/redact.ts`
  (API keys, GitHub/Slack tokens, AWS keys, JWTs, private keys, credential
  assignments, URL credentials).
- **Imported artifacts are untrusted.** ZIP/HTML/asset imports go through
  `src/security/zip.ts`, which rejects path traversal, absolute paths and
  symlinks, enforces entry/total size limits, refuses to extract executables
  and flags npm install scripts. Nothing from an import is executed before
  inspection, ever.
- **Verification commands run under a strict policy, never a shell.** Every
  command is parsed and validated by `src/core/commands.ts` and executed as
  `executable + args` with `shell: false`. Shell metacharacters (pipes,
  redirection, chaining, substitution, globs) are rejected; only an allowlist
  of build/test executables is permitted; publish/login/remote sub-commands
  and path-qualified executables are denied. A rejected command is a hard
  BLOCK, never a repairable failure. `git` is driven only through the typed
  GitOps layer, so `git push`/`git remote` can never be smuggled through a test.
- **Commands suggested by imported artifacts are not executed** without
  validation; the design import pipeline never runs package scripts.
- **Write scope is enforced by the real filesystem delta, not the agent's
  report.** A snapshot is taken before each task group and compared afterwards;
  any file changed outside the declared write scope raises a hard error even if
  the agent omitted it from `files_written` (`src/core/scope.ts`).
- **Automatic commits stage only authorized paths** (the task-scoped source
  changes plus RIJO artifacts) — never `git add -A` — so pre-existing local
  edits are never swept into a phase commit.
- **Workers are scope-restricted.** Every agent task declares a write scope;
  results are validated by `enforceWriteScope` and out-of-scope writes raise
  `ScopeViolationError`. Paths outside the workspace are rejected by
  `assertInsideRoot`.
- **Destructive operations stop.** Unknown local changes are never discarded,
  overwritten or auto-stashed; RIJO blocks with a diagnostic. Historic
  milestones are immutable.
- **`$rijo test` never deploys** or changes production. It only evaluates and
  reports.
- Executed commands and their exit codes are recorded in `events.jsonl` and
  VERIFICATION.md for audit.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the
maintainer. Do not open public issues for exploitable problems. You should
receive a response within 7 days.
