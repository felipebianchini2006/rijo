# Go-live certification report

- **Certification date:** 2026-07-24
- **Certified commit:** `e7232471932762595a52d8ae917bddbdb04153e6` (HEAD of `origin/main`)
- **Method:** independent re-execution from a **fresh clean clone** of
  `https://github.com/felipebianchini2006/rijo.git` (branch `main`) into an
  empty directory, plus a second independent clone for the Node 22 leg. No
  repository file was modified during the certification run; this report and
  `artifacts/go-live/` were committed **after** the run, as evidence only.
- **Verdict:** **BLOCKED** — every executed criterion passed; exactly one
  criterion could not be executed (Codex live E2E) because of an external,
  account-level capacity limit. See §7.

## 1. Environment

| Item | Value |
|---|---|
| Host | macOS 26.5.2 (Darwin 25.5.0, arm64) |
| Node (primary) | v24.18.0 |
| Node (matrix) | v22.23.1 |
| npm | 11.16.0 |
| git | 2.55.0 |
| Claude Code CLI | 2.1.202 (live) |
| Codex CLI | 0.146.0-alpha.3.1 (reached, quota-blocked) |

## 2. Build, tests and packaging (clean clones)

| Step | Node 24 | Node 22 |
|---|---|---|
| `npm ci` | exit 0 | exit 0 |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm test` (full suite) | **43 files, 333 passed, 3 skipped** | **43 files, 333 passed, 3 skipped** |
| `npm run build` | exit 0 | exit 0 |
| `npm pack` | `rijo-0.1.0-alpha.1.tgz` | — |

The 3 skips are the live-gated tests (they ran separately under
`RIJO_LIVE_E2E=1`, §5) — nothing else was skipped. Tarball SHA-256:
`d783809cb2032990d84e9d7f61a24394619e92cfe5f22211b56b3f52af6caac6`
(`artifacts/go-live/tarball.sha256`).

### Tarball validation in a clean fixture

`npm install <tarball>` → exit 0; `npx rijo --version` → `0.1.0-alpha.1`;
`npx rijo --status --json` → valid JSON with `schema_version: 2`;
`import('rijo')` → 53 exports. Log: `artifacts/go-live/tarball-audit.log`.

## 3. Real browser and fault-injection coverage (inside the suite)

Both legs re-executed, in the clean clones, with real subsystems:

- **Production gate E2E** (`tests/gate.e2e.test.ts`, 4 scenarios): real app
  fixture, real git checkout of the exact commit, real `npm ci`, server under
  the network-restricted sandbox, **real Playwright chromium** on desktop and
  mobile viewports — READY / BLOCKED-on-dirty-tree / NOT_READY-with-evidence /
  `--fix` full re-run all passed.
- **Supervisor fault injection**: 20 fake-clock scenarios plus 4 real-process
  scenarios (frozen child, SIGTERM-ignoring child SIGKILLed, late responder
  discarded, dead pipe replaced; all pids verified dead).
- **Milestone transaction crash safety**: fault injected after every durable
  write; no observable intermediate state.
- **Bridge resilience** (13 scenarios + real child process), **lease lock**
  (14), **expert profiles/router** (31).

## 4. CI on the certified commit

GitHub Actions run **30091454874** on `main` at exactly
`e723247…` → **success, 5/5 jobs**: `test-and-pack` on
ubuntu-latest × {22.x, 24.x}, windows-latest × {22.x, 24.x}, and `security`
(npm audit + CycloneDX SBOM). Snapshot: `artifacts/go-live/ci-run.json`.

## 5. Live host E2Es (fresh, executed during this certification)

| Item | Result | Evidence |
|---|---|---|
| Claude Code CLI — driver E2E | **passed** (real `claude -p`, parsed AgentResult, 8.2s) | `artifacts/go-live/live-e2e.log` |
| Supervisor Part-M — real Claude attempt terminated | **passed**: two real processes deliberately terminated at the hard deadline; CANCELLING → REPLACING (gen 2, fresh workspace) → EXHAUSTED; bounded < 60s; both pids dead; nothing applied; receipts without secrets | `artifacts/go-live/live-e2e.log` |
| Codex CLI — driver E2E | **blocked** (external capacity, §7) | `artifacts/go-live/live-e2e.log`, `artifacts/go-live/codex-probe.log` |

## 6. Security

- `npm audit --omit=dev --audit-level=high` → **0 vulnerabilities**.
- SBOM: CycloneDX 1.5, 58 components → `artifacts/go-live/sbom.cdx.json`.
- Not published to npm at any point (certification rule).

## 7. The single blocker (precise diagnosis)

**Codex live E2E cannot run**: a fresh probe during this round
(`codex exec --json …`) reached and authenticated against the host
(`turn.started` emitted) and then failed with the account-level message
“You've hit your usage limit. … try again at Jul 28th, 2026 2:04 PM.”
This is external capacity, not a driver or protocol defect — the driver
surfaced the exact host error, and the same code path (ProcessController +
CLI driver) passed live against Claude Code. Per policy, a fake runner is
never accepted as host E2E evidence, so this criterion stays open.

**To clear it:** re-run, after 2026-07-28 14:04 (or after adding credits):

```bash
RIJO_LIVE_E2E=1 npx vitest run tests/live-e2e.test.ts
```

If it passes on the certified commit with no other change, this round's
matrix remains valid and the verdict lifts to **READY**.

## 8. Verdict

**BLOCKED** — all executed criteria passed on the certified commit
(`e723247…`) from clean clones; the sole open criterion is the Codex live
E2E, blocked by external account capacity until 2026-07-28 14:04. No version
recommendation is updated (release-candidate recommendation only after
READY, per certification policy).

## Artifacts

```
artifacts/go-live/environment.txt     — certification environment
artifacts/go-live/matrix-node24.log   — ci/typecheck/test/build/pack (Node 24)
artifacts/go-live/matrix-node22.log   — ci/typecheck/test/build (Node 22)
artifacts/go-live/tarball-audit.log   — fixture install + audit + SBOM summary
artifacts/go-live/tarball.sha256      — SHA-256 of rijo-0.1.0-alpha.1.tgz
artifacts/go-live/live-e2e.log        — live Claude E2E + live Part-M + Codex block
artifacts/go-live/codex-probe.log     — fresh Codex quota probe (raw JSONL)
artifacts/go-live/ci-run.json         — CI run 30091454874 (5/5 success)
artifacts/go-live/sbom.cdx.json       — CycloneDX 1.5 SBOM (58 components)
```
