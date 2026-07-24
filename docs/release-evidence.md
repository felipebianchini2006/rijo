# Release evidence — production hardening (0.1.0-alpha.1 → release-candidate track)

Every claim below corresponds to a command actually executed and read, on the
date shown. Fake runners prove deterministic logic only and are never cited as
host E2E evidence.

## Environment

| Item | Value |
|---|---|
| Host | macOS (Darwin 25.5.0, arm64), MacBook Pro |
| Node (primary) | v24.18.0 (mise) |
| Node (matrix) | v22.23.1 (mise) |
| npm | 11.16.0 |
| git | 2.55.0 |
| Playwright | 1.61.1 (@playwright/test, chromium installed in ms-playwright cache) |
| Claude Code CLI | 2.1.202 |
| Codex CLI | 0.146.0-alpha.3 |
| OS sandbox | /usr/bin/sandbox-exec (Seatbelt) present |
| Date of final evidence pass | 2026-07-24 |

## Commits of this hardening effort (branch `dev/rijo-alpha-release-candidate-77c9eb`)

```
156547f feat(core): per-attempt workspace isolation, task lifecycle, canonical baseline
ad22e2d feat(security): capability-based execution policy with native sandbox
a2d4c88 feat(workflows): two-commit evidence model for fix, baseline commit on new
dd5c122 feat(core): crash-safe milestone transactions for new --next
870a484 feat(research): fail-closed volatile decisions, source tiers, compaction
bac2a96 feat(qa): check --production as an executable gate on the exact commit
2479fe9 feat(ui,ci): hardened UI import pipeline; CI matrix + SBOM
15c4f2c docs: security model, execution policy, commit/evidence model, production readiness
3fefc60 feat(hosts): real Claude Code and Codex CLI drivers, live E2Es, concrete model routing
785b9ae fix(deps): adm-zip ^0.6.0 — GHSA-xcpc-8h2w-3j85 (high)
4619982 fix(cross-platform): CI-exposed defects on Linux/Windows runners
```

## Local command matrix (fresh executions, 2026-07-24)

| Command | Node | Exit | Result |
|---|---|---|---|
| `npm ci` | 24.18.0 | 0 | dependencies installed |
| `npm run typecheck` | 24.18.0 | 0 | clean |
| `npm test` | 24.18.0 | 0 | **38 files, 253 passed, 2 skipped** (skips = live E2Es, gated by `RIJO_LIVE_E2E`) |
| `npm run typecheck` | 22.23.1 | 0 | clean |
| `npm test` | 22.23.1 | 0 | 38 files, 253 passed, 2 skipped |
| `npm run build` | 22.23.1 | 0 | dist/ built |
| `npm pack` | 24.18.0 | 0 | `rijo-0.1.0-alpha.1.tgz` |
| `npm audit --omit=dev --audit-level=high` | 24.18.0 | 0 | **0 vulnerabilities** (after adm-zip ^0.6.0 upgrade; before it: 1 high, GHSA-xcpc-8h2w-3j85) |
| `npm sbom --sbom-format cyclonedx` | 24.18.0 | 0 | CycloneDX 1.5, 58 components |

### Tarball validation in a clean fixture (local, 2026-07-24)

```
npm install <tarball>          → exit 0 (4 packages)
npx rijo --version             → 0.1.0-alpha.1
npx rijo --status --json       → valid JSON status snapshot
node -e "import('rijo')..."    → 53 exports, including AttemptWorkspace,
                                 ClaudeCliRunner, CodexCliRunner, detect*,
                                 validate*Model, parse*Stdout
```

## Real CI matrix (GitHub Actions, repo felipebianchini2006/rijo)

| Run | Trigger | Result |
|---|---|---|
| 30085666100 | push (first attempt) | **FAILED — genuine cross-platform defects found**: (1) git commit without identity on fresh runners; (2) gate installs blocked without a native OS sandbox; (3) Windows `.cmd` shim spawn (ENOENT/EINVAL); (4) Windows `fsync` EPERM on read-only fd |
| 30086017881 | push (after fixes, commit 4619982) | **SUCCESS — all 5 jobs green**: `test-and-pack (ubuntu-latest, 22.x)`, `(ubuntu-latest, 24.x)`, `(windows-latest, 22.x)`, `(windows-latest, 24.x)`, `security` (audit + CycloneDX SBOM artifact). Each matrix leg ran npm ci, typecheck, the full test suite, build, pack and the clean-fixture tarball validation. |

## Browser / production-gate E2E (real, local, macOS)

`tests/gate.e2e.test.ts` — real minimal HTTP application fixture, real git
repository, real `npm ci`, server started and terminated by RIJO under the
network-restricted sandbox, real Playwright chromium on desktop (1440×900) and
mobile (390×844):

| Scenario | Result |
|---|---|
| READY on the exact clean commit | PASSED (all commands exit 0, journey passed on both viewports, `tested_commit` = HEAD, `evidence_commit` recorded, tree clean) |
| Dirty tree before the gate | BLOCKED (gate refused before running anything) |
| Broken flow (sabotaged API) | NOT_READY with REAL failure evidence on disk: `trace.zip`, `test-failed-1.png`, `error-context.md`, `server.log` |
| `check --production --fix` | Repair in isolated workspace → committed → ENTIRE matrix re-ran on the new commit → READY pointing at the fixed commit |

## Host E2Es (live, real CLIs, 2026-07-24)

Report classes: `not_run` / `blocked` / `passed` / `failed`.

| Host | Status | Evidence |
|---|---|---|
| Claude Code CLI 2.1.202 | **passed** | `RIJO_LIVE_E2E=1 npx vitest run tests/live-e2e.test.ts` — real `claude -p` run returned a parsed AgentResult with the expected payload |
| Codex CLI 0.146.0-alpha.3 | **blocked** | Host REACHED and authenticated: `thread.started` returned (thread `019f939b-1e3b-7793-862f-2da7f4e01fba`), then `turn.failed`: “You've hit your usage limit… try again at Jul 28th, 2026 2:04 PM.” Account-level capacity, not a driver defect. The live test records this as a skip labelled `BLOCKED (host capacity)` with the exact message. |
| Bridge child process | **passed** | `tests/bridge-child.test.ts` spawns a REAL `node dist/cli/index.js serve` child and drives `workflow.new` + `workflow.run` over stdio JSON-RPC |

## Known limitations (real, not hidden)

1. **Codex live E2E blocked by account quota until 2026-07-28 14:04** — the
   only unproven item of the host-integration matrix. Per policy, no stable
   release until both live host E2Es have passed in a release environment.
2. Native OS sandbox is implemented for macOS (Seatbelt). On Linux/Windows,
   repository-code execution requires `execution.sandbox: approved-unsandboxed`
   (explicit, recorded opt-out) or an external sandbox; gate installs are
   exempt (lifecycle scripts always off). Documented in
   `docs/execution-policy.md`.
3. Windows spawns `.cmd` shims through a shell (metacharacters are still
   rejected by the string gate before any spawn).
4. The gate’s real-browser E2E runs on macOS in CI-of-this-repo terms
   (self-skips off darwin); the CI matrix covers determinism, packaging, paths,
   locks and processes on Linux/Windows.
5. `docs/readiness.md` documents the earlier alpha.1 audit; the adm-zip pin
   noted there was superseded by the ^0.6.0 upgrade (audit clean).

## Addendum — Prompt 02 (resilient supervisor + expert profiles), 2026-07-24

| Item | Evidence |
|---|---|
| Full suite (Node 24.18) | 43 files, **333 passed, 3 skipped** (skips = live-gated) |
| Full suite (Node 22.23, mise) | 43 files, 333 passed, 3 skipped; build OK |
| Supervisor fake-clock fault matrix | tests/supervisor.test.ts — 20 scenarios (no-response host, heartbeat stop, hard deadline with live heartbeat, slow-but-healthy not replaced, ack/no-ack cancel, force terminate, fencing without force, late/duplicate/old-lease results, fresh replacement identity+workspace, EXHAUSTED→BLOCKED, dispose without orphan timers, independent task continues, crash-window recovery) |
| Real-process fault injection | tests/supervisor-process.test.ts — frozen child, SIGTERM-ignoring child (SIGKILL proven), late responder discarded, dead pipe replaced; all spawned pids verified dead |
| Bridge resilience | tests/bridge-resilience.test.ts (13) — HOST_TIMEOUT, HOST_DISCONNECTED on EOF, duplicate idempotency, attempt-echo fencing, abort→cancelTask, queue deadline, zero unhandled rejections; child-kill and stdin-close mid-workflow in tests/bridge-child.test.ts |
| Lease lock | tests/locks.test.ts (14) — expiry/wedged-heartbeat reconciliation, reclaimed orphan attempts, renewal under withLock, no manual-deletion path |
| Expert profiles | tests/experts.test.ts (31) — deterministic router, ≤3 profiles, researcher=1, reviewer independence, single-source Claude+Codex adapters with concrete models |
| **LIVE Part-M E2E (real Claude Code CLI)** | **PASSED** on this host (`RIJO_LIVE_E2E=1`): two real `claude -p` processes deliberately terminated at the hard deadline; record shows CANCELLING → REPLACING (generation 2, fresh workspace) → EXHAUSTED, bounded <60s; both real pids dead (no orphans); killed attempts applied nothing; receipts in task-events.jsonl without secrets |
| Codex live supervision | **blocked** — same account usage limit as Prompt 01 (until 2026-07-28 14:04); the ProcessController path is host-agnostic and proven with real processes + the Claude host |
| Status surface | `rijo --status --json` v2 (additive) with supervisor block; human panel shows attempt/generation/heartbeat/progress/replacements/state |
