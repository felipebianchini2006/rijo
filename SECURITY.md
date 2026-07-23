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
- **Commands suggested by imported artifacts are not executed** without
  validation; the design import pipeline never runs package scripts.
- **Workers are scope-restricted.** Every agent task declares a write scope;
  results are validated by `enforceWriteScope` and out-of-scope writes raise
  `ScopeViolationError`. Paths outside the workspace are rejected by
  `assertInsideRoot`.
- **Destructive operations stop.** Unknown local changes are never discarded,
  overwritten or auto-stashed; RIJO blocks with a diagnostic. Historic
  milestones are immutable.
- **`rijo check` never deploys** or changes production. It only evaluates and
  reports.
- Executed commands and their exit codes are recorded in `events.jsonl` and
  VERIFICATION.md for audit.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository, or email the
maintainer. Do not open public issues for exploitable problems. You should
receive a response within 7 days.
