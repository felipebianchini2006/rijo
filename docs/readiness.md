# Readiness hardening (0.1.0-alpha.1)

This release resolves the P0 blockers and the P1 issues from the readiness
audit. Each item below names the fix and the test that proves it.

## P0 blockers

| # | Blocker | Fix | Proof |
|---|---|---|---|
| P0.1 | Host↔core bridge missing | JSON-RPC `rijo serve --stdio` + `RpcAgentRunner`; adapters document the protocol | `tests/bridge.test.ts` drives `new` then `run all` over an in-memory transport |
| P0.2 | Public API not importable | `main`/`types`/`exports` in package.json | `tests/pack.e2e.test.ts` imports `runWorkflow`/`serve` from the installed tarball |
| P0.3 | `new --run` double lock | `runCore(ctx)` reuses the enclosing lock | `tests/composition.test.ts` |
| P0.4 | `new --ui` didn't import | `uiCore(ctx)` composed inside `new` | `tests/composition.test.ts` |
| P0.5 | Arbitrary shell execution | Structured commands, `shell:false`, allowlist, metachar/publish/remote denial | `tests/hardening.test.ts` (command policy) |
| P0.6 | Write scope trusted the agent | Filesystem snapshot/delta enforced against declared scope | `tests/hardening.test.ts` (hidden out-of-scope edit caught) |
| P0.7 | Phase could pass with zero evidence | Zero verification commands → `BLOCKED` unless an auditable waiver | `tests/hardening.test.ts` (`NO_VERIFICATION_EVIDENCE`) |
| P0.8 | Uncovered requirement marked DONE | Bidirectional coverage lint; uncovered requirement blocks the plan | `tests/hardening.test.ts` (`REQ_NOT_COVERED`) |
| P0.9 | Milestone transition not transactional | Extract + validate before sealing; deterministic ID; terminal carryover lineage | `tests/hardening.test.ts` (planner failure leaves history intact; no re-carry) |
| P0.10 | `check` not a real gate | Every journey must pass, requirements must be DONE, build must run, matrix re-run after `--fix`, report pinned to the tested commit; real `npx playwright test` when declared | `tests/check-workflow.test.ts` |
| P0.11 | Commits could sweep user edits | Baseline snapshot; `commitPaths` stages only authorized files; artifacts finalized before commit, hash synced after | `tests/run-workflow.test.ts` (commit stages only src/a.ts) |

## P1 issues

- Model routing operational: every task carries the role's configured tier
  (`dispatch`/`dispatchBatch`), and the Claude adapter stamps `model:` on
  generated agents.
- Reviewer receives the real change set (file contents), not just names.
- UI import refreshes the manifest after writing STATE (no self-inflicted drift).
- Schema-version mismatch is detected and blocks (`checkSchemaCompatibility`).
- Atomic write flushes with `fsync` and never destroys the original before its
  replacement is in place.
- `adm-zip` pinned to `^0.5.18` (CVE-2026-39244) with a size-guard test.
- `blocked()` persists the blocked state durably when a phase is in progress,
  and refreshes manifest hashes to avoid drift on resume.

## Still explicitly out of scope for alpha

- No live model E2E is bundled (would require provider credentials); the whole
  suite runs against a `FakeAgentRunner`/in-memory bridge.
- Real browser + Playwright execution happens only when the target project
  declares `@playwright/test` and a config; otherwise journeys are agent-driven
  and a missing browser yields `BLOCKED`, never `READY`.
- Git-worktree isolation for parallel writers remains optional; scope is
  enforced at group granularity by filesystem diff instead.
