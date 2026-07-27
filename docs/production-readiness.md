# Production readiness

`$rijo test` never deploys. It produces one of three statuses:
`READY`, `NOT_READY`, or `BLOCKED` — written to
`.rijo/milestones/<id>/qa/production-readiness.md`, and it is READY only when
**every** gate passes; there is no partial credit and no inference. This
document describes the required evidence. It also explains the result states,
waivers, and current limits.

## Native product Quality Assurance

The native `test` workflow runs deterministic project checks and real user
journeys. It uses the browser, computer-use, simulator, or emulator tools that
the active host provides.

The workflow records screenshots, traces, logs, network failures, console
errors, accessibility defects, and visual defects. It fixes bounded defects and
runs affected journeys again.

The deterministic production gate in `src/qa/gate.ts` can certify one exact
commit with Playwright. Secondary automation can invoke that gate through the
legacy Command-Line Interface.

## What `READY` requires

### Exact-commit production gate

Every one of the following must hold, in order — the first failure that
cannot be satisfied determines the status:

1. **Known, pinned HEAD** on a **clean tree** (`git status`), except the
   gate's own `qa/traces/` evidence subdirectory, which is exempt so repeated
   `--fix` rounds can accumulate evidence without dirtying the certification.
2. **Configuration complete**: `qa.start_command` non-empty, `qa.health_url`
   set, `qa.browsers` non-empty, and every derived journey has a structured
   `qa/journeys/<id>.actions.json` file (a journey without one blocks — it
   never falls back to a placeholder spec).
3. **Every configured browser installed** (`playwright install <browser>`
   verified against the local Playwright cache).
4. **Clean checkout materializes**: `git worktree` of `tested_commit` succeeds
   into an isolated directory.
5. **Reproducible install**: the checkout declares `@playwright/test`, a
   `package-lock.json` exists, and `npm ci --ignore-scripts` exits 0.
6. **Every declared deterministic script** (`typecheck`, `lint`, `build`,
   `test` — whichever the checked-out `package.json` actually declares) exits
   0, run inside the checkout.
7. **Deterministic Playwright codegen succeeds and passes lint**: every
   generated spec drives at least one real UI action, is linked to a
   requirement ID, and contains no placeholder markers
   (`TODO`/`TBD`/`FIXME`/`placeholder`) or body-visible-only assertions.
8. **The application becomes healthy** at `qa.health_url` within
   `qa.startup_timeout_ms`.
9. **Real Playwright execution** produces a structured `results.json`; every
   journey's spec actually ran (not merely "not executed").
10. **Nothing changed during the run**: re-checking `git status`/HEAD after
    the gate must show the exact same commit and no foreign dirty files
    (outside `qa/traces/`) — any drift invalidates the round.
11. **Every check and every journey passes**, OR the failing journey carries
    an explicit, versioned waiver (see below).
12. **Every active requirement** (status not `CANCELLED`/`CARRIED`) is
    covered by at least one journey **and** is `DONE` or `DEBT`.

### Native journey mode

The native workflow uses `decideReadiness` (`qa/readiness.ts`). It combines
locally-run deterministic checks (`format:check`, `lint`, `typecheck`,
`build`, `test`, `test:integration`, and `test:e2e`) with real user journeys.
It can also run Playwright when the project declares it. `READY` requires no missing
capability, a pinned commit, every check green (a missing production build
script or a failing one always blocks), every requirement covered by a
journey and `DONE`/`DEBT`, and every journey either passed cleanly (no
unhandled console errors, no 4xx/5xx network errors) or waived, with no open
`blocker`/`critical`/`high` finding from the independent visual review.

## `NOT_READY` vs `BLOCKED`

These are not degrees of the same failure — they mean different things and
are produced by different conditions.

**`BLOCKED`** — the gate **could not execute at all**, so nothing was
certified. Causes:

- an indispensable capability is missing (no browser-capable runtime — the
  local mode's `missingCapabilities` check, or the gate's missing
  `@playwright/test`/browser binary/config);
- the tree was dirty, or the repo changed mid-run;
- the checkout, install, or server start failed;
- the evidence commit's diff range touched a non-evidence path (a commit
  hygiene violation caught after the fact).

`BLOCKED` is `decideReadiness`'s and the gate's honest admission that it has
no verdict to offer — it is never treated as equivalent to failure evidence,
and it is never silently promoted to `READY`.

**`NOT_READY`** — the gate **ran successfully** and produced real evidence
that something is not ready: a failing check, a failing or unwaived-not-run
journey, an uncovered or non-`DONE` requirement, or an open
`blocker`/`critical`/`high` finding. This is a certified negative result,
with the specific reasons listed in the report.

A useful way to read it: `BLOCKED` means "ask again once the gate itself can
run"; `NOT_READY` means "the gate ran and here is exactly what to fix."

## Waivers

`config.qa.waivers` is an array of `{ journey_id, reason }` entries, versioned
in `config.yml` alongside the rest of the project's committed configuration
— never a runtime flag or an undocumented skip. A waived journey's failure is
reported as `WAIVED journey <id> (<reason>) — auditable, versioned in config`
and does **not** count toward the hard-failure list that would otherwise force
`NOT_READY`. A waiver does not exempt the requirement-coverage gate: every
active requirement must still be covered by a journey (waived or not) and
still be `DONE`/`DEBT` — a waiver excuses "this journey didn't pass," never
"this requirement was never verified."

(`config.research.waivers` is a separate, unrelated waiver mechanism for
fail-closed volatile research decisions — see `docs/security-model.md`; it
has no bearing on production readiness.)

## Bounded repair

The workflow supports a bounded repair loop (`config.limits.qa_fix_loops`
rounds). Each round dispatches a worker in an isolated workspace to fix
failures grouped by root cause, applies the verified patch, commits it, and
then **re-runs the entire matrix** — not just the previously failing subset
— against the new commit. This is deliberate: a fix for one journey can
regress another, so a partial re-run could certify `READY` against evidence
that no longer describes the current commit. If a repair
leaves the working tree dirty, the result is forced to
`NOT_READY` even if every gate would otherwise pass — a readiness report may
only certify a committed, reproducible state.

## Current limits

- **Real Playwright execution requires a Playwright-capable runtime and, for
  `--production`, `darwin` + Seatbelt (`/usr/bin/sandbox-exec`) for the
  sandboxed server process.** `tests/gate.e2e.test.ts` and
  `tests/sandbox.test.ts` self-skip when that combination is unavailable —
  they are not exercised as live E2E on every host.
- **CI is multi-OS but not macOS.** `.github/workflows/ci.yml` runs the full
  suite on `ubuntu-latest` and `windows-latest` × Node `22.x`/`24.x`,
  including `npm pack` + packaged-tarball validation on every matrix leg. It
  does **not** include a macOS runner, so the Seatbelt sandbox path and the
  real `--production` gate execution are only verified when the suite runs
  locally on macOS (or on a future macOS CI runner) — not automatically on
  every push/PR.
- **No live model/agent-provider E2E is bundled.** The entire test suite,
  including the gate and commit-model tests, runs against a
  `FakeAgentRunner`/in-memory bridge; there is no CI job that exercises a real
  Claude/Codex provider end to end.
- **Native journey execution depends on the tools that the active host
  provides.** RIJO does not simulate a browser, simulator, or emulator
  capability. A missing required capability returns `BLOCKED`.

## Proven by

- `tests/gate.e2e.test.ts` — READY on a clean checkout with real
  server + real Playwright on desktop and mobile viewports; `BLOCKED` on a
  dirty tree before anything runs; `NOT_READY` with failure evidence when the
  real flow is broken; `--fix` repairs in an isolated workspace, commits, and
  re-runs the entire matrix to `READY`.
- `tests/check-workflow.test.ts` — `BLOCKED` when browser capability is
  missing (never `READY` by inference); `READY` with pinned commit and
  evidence when all gates pass; a console error or a 5xx network error in a
  critical flow prevents `READY`; a relevant visual finding appears in the
  report; `--fix` groups failures and re-runs only failing journeys locally,
  bounded at the configured round count; a requirement without journey
  coverage prevents `READY`; a failed production build prevents `READY`.
- `tests/playwright-gen.test.ts` — spec codegen only for journeys with
  structured actions; lint rejects placeholder-only or unlinked specs.
