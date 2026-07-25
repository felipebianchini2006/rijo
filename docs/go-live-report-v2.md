# Go-live report v2 — correction & certification cycle (P0.1–P0.10)

- **Date:** 2026-07-24
- **Certified commit:** `0a7ef0b` (branch `dev/rijo-alpha-release-candidate-77c9eb`)
- **Method:** every gate re-executed from **fresh clean clones** of
  `https://github.com/felipebianchini2006/rijo.git`. The clone matrix and live
  E2Es ran at `029a1ea`; the only delta to the certified commit is
  `tests/locks.test.ts` (a test-hardening change, no product code), revalidated
  by CI run 30135389766 at `0a7ef0b` itself.
- **Verdict:** **`READY_CLAUDE_ONLY`** — every mandatory gate passed live on
  Claude Code; Codex remains **experimental** solely because its live E2E is
  quota-blocked (§8). Not published to npm; version unchanged.

## 1. Environment

| Item | Value |
|---|---|
| Host | macOS 26.5.2 (Darwin 25.5.0, arm64) |
| Node | v24.18.0 (primary), v22.23.1 (matrix leg) |
| npm / git | 11.16.0 / 2.55.0 |
| Claude Code CLI | 2.1.202 — live, exercised end-to-end |
| Codex CLI | 0.146.0-alpha.3.1 — reachable, quota-blocked until 2026-07-28 14:04 |

## 2. What the correction cycle delivered (P0.1–P0.9, all landed)

| Item | Delivery (commit) |
|---|---|
| P0.1 Supervisor em todo dispatch | `TaskExecutor`/`SupervisedExecutor`: TaskRecord durável antes do host, identidade attempt/generation/lease/idempotency, batch independente, EXHAUSTED→BLOCKED (`2e47bd7`) |
| P0.2 Controllers reais | `buildClaudeLaunch`/`parseClaudeExit` + Codex equivalentes como fonte única; `ClaudeProcessController`/`CodexProcessController` donos do PID; `RpcHostController` (heartbeat/progress → liveness, cancel com ack limitado, force gated por capability) (`1a5a65a`) |
| P0.3 Árvore inteira | `killProcessTree`: POSIX process group (`-pgid`, fallback ESRCH), Windows `taskkill /PID /T /F` argv estruturado; os 4 caminhos de kill; teste real pai→filho→neto (`1a5a65a`) |
| P0.4 Fuga de escrita | sem `--add-dir` do projectRoot; cwd = workspace da tentativa; permission-mode por papel (writers `acceptEdits`, read-only `plan`); deny rules p/ `.env*`, chaves, `~/.ssh` etc.; teste live de escrita negada (`1a5a65a`) |
| P0.5 Recovery no início | `withLock`: transações → tasks supervisionadas → workspaces órfãos, antes do body; reconcile idempotente (2ª passada = 0 eventos); QUEUED→CANCELLED→EXHAUSTED; CANCELLED/FAILED → REPLACING\|EXHAUSTED por budget, nunca por ORPHANED proibido; completed-pendente descartado com fencing; testes table-driven (`d05184e`) |
| P0.6 Profiles em tasks reais | `prepareDispatchedTask` roteia TODO draft (role/stage/paths/tags/high-risk); reviewer nunca herda lente autoral; researcher = discovery-analyst; testes por workflow (`2e47bd7`) |
| P0.7 Finalização transacional | marcador `FINALIZING` durável; ordem verificação→artefatos→checkpoint→C1→evidence→C2→seal→validações→DONE; retomada sem reexecutar implementação; fault injection nas 8 janelas com git real (`2c569d4`) |
| P0.8 Deadline sem overlap | `raceWithUnwind` no serve: cancel → settle comprovado (lock liberado) → resposta; teto duro bloqueia a fila em vez de sobrepor; testes de ordenação (`7b194a0`) |
| P0.9 Turnkey | `rijo new/run/check/ui/fix --host claude|codex` + config `host.provider`; detect→BLOCKED se ausente; skills invocam o comando turnkey; `serve --stdio` como API avançada (`8c95870`) |
| Replacement com workspace novo | `replaceableAttempt`: gen N+1 = task re-roteada + workspace novo; gen substituída descartada (`20c8747`) |
| 9 defeitos reais achados pelo host live | keep-alive do supervisor, permission de escritores canônicos, leak de workspace substituído, re-plan/re-review dentro do budget, objetivo do worker, retry de extração, lint de comandos de teste, looseBool (`7ee5272`) |

## 3. Clean-clone command matrix

| Command | Node 24 | Node 22 |
|---|---|---|
| `npm ci` / `npm run typecheck` | 0 / 0 | 0 / 0 |
| `npm test` | **54 files, 418 passed, 7 skipped** (skips = live-gated only) | **418 passed, 7 skipped** |
| `npm run build` / `npm pack` | 0 / 0 (`rijo-0.1.0-alpha.1.tgz`) | 0 / — |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** | — |
| SBOM | CycloneDX 1.5 (`artifacts/go-live-v2/sbom.cdx.json`) | — |

Tarball SHA-256:
`9d77172d990817bf03002bb8efe41389ff9117af8c216c84ccbec0fca5b096c9`.

## 4. LIVE full-workflow E2E — Claude (clean clone, real CLI)

**Scenario A — turnkey from the packed tarball: PASS.**
`npm pack` → install in a clean fixture → `git init` →
`rijo new @PLANO.md --host claude --run`. Asserted: exit 0; phase **DONE** in
ROADMAP; **C1** ("…verified"), **C2** ("evidence for…") and **seal** commits
plus the "milestone initialized" baseline in the fixture's real git; the
task's source file committed; clean tracked tree; `rijo --status --json`
coherent (`schema_version: 2`, supervised task SUCCEEDED); task-events.jsonl
with zero secrets.

**Scenario B — real stall → whole-tree kill → replacement completes: PASS.**
A PATH shim (documented in the test header) proxies every call to the REAL
`claude` binary except the first exec-worker invocation, where it spawns a
real child + grandchild, records their pids, ignores SIGTERM and hangs —
**it never fabricates a model result** (a stalled generation produces
nothing; every accepted answer comes from the real Claude). Asserted from the
durable record and the OS: shim + child + grandchild ALL dead
(`kill(pid,0)` throws); events contain CANCELLING → `force_terminated` →
REPLACING; the exec task ends at **generation 2, replacements 1, SUCCEEDED**;
generation-1's workspace discarded; only generation-2's patch applied;
C1/seal commits present; clean tree; exit 0.

**Honest variance disclosure:** in the clean clone the combined first run had
Scenario A pass and Scenario B fail once ("run did not exit 0 after
replacement" — the live plan/review stages have real per-run model variance);
the isolated re-run of Scenario B from the same clone **passed** (298s), and
the full A+B combination had already passed in the workspace before commit.
These E2Es are opt-in reliability probes (`RIJO_LIVE_E2E=1`) with bounded
retry budgets, not deterministic unit tests; logs of both runs are kept
(`live-workflow.log`, `scenarioB-rerun.log`). No orphan process remained
after any run, including the failed one.

## 5. Codex

- Fresh probe and the gated workflow E2E (`RIJO_LIVE_CODEX_E2E=1`) both hit
  the account limit: host reached and authenticated, then
  "You've hit your usage limit… try again at Jul 28th, 2026 2:04 PM" —
  recorded as a **labeled `BLOCKED_BY_QUOTA` skip**, never silent.
- Per the completion rule, Codex therefore remains **experimental**: drivers,
  process controller and adapters exist and are unit/fault-tested, but no live
  workflow evidence is claimed.

## 6. CI matrix (real, GitHub Actions)

| Run | Commit | Result |
|---|---|---|
| 30135166649 | `029a1ea` | 4/5 — `windows-latest, 24.x` failed on a genuinely timing-fragile lease-renewal assertion (single-instant read vs delayed interval on a loaded runner) |
| **30135389766** | **`0a7ef0b`** | **SUCCESS 5/5** — ubuntu/windows × Node 22/24 + security, after hardening the assertion to test the actual contract (lease keeps being extended) |

## 7. Additional mandatory tests (all in the suite, clean clone)

Supervisor integrado em new/run/ui/fix/check (workflow-supervision, -profiles);
bridge heartbeat/progress/cancel-ack (rpc-controller, bridge-resilience);
stale result pós-replacement; árvore pai/filho/neto morta (process-tree-kill);
escrita canônica negada (live-claude-write-fence, gated); recovery de todos os
estados + 2 passadas idempotentes (recovery-states); fault injection em toda a
finalização Git (finalization-txn); deadline sem overlap (bridge-deadline);
tarball importável/executável (pack.e2e + fixture); Node 22/24; Ubuntu/Windows
no CI para lógica de processos; audit high = 0; SBOM; recibos sem secrets.

## 8. Real limitations

1. **Codex live E2E quota-blocked until 2026-07-28 14:04** — the sole reason
   the verdict is not full `READY`. To lift: on the certified commit,
   `RIJO_LIVE_CODEX_E2E=1 npx vitest run tests/workflow-live-codex.e2e.test.ts`.
2. Live workflow E2Es have real per-run model variance at plan/review stages
   (§4); they are gated, budgeted probes — CI relies on the deterministic
   suite.
3. Windows has no graceful tree-terminate (`taskkill /T /F` is unconditional);
   the SIGKILL rung is unreachable there by OS semantics (documented, tested).
4. Native OS sandbox is macOS Seatbelt; Linux/Windows repository-code
   execution requires the explicit `approved-unsandboxed` opt-out.

## 9. Verdict

**`READY_CLAUDE_ONLY`** — the required chain was proven live end-to-end on
Claude Code from a clean clone and the packed tarball:
workflow real → dispatch supervisionado → tentativa real trava → árvore
encerrada → fencing → replacement em workspace novo → resultado atual
aplicado → testes executados → commits finalizados → recovery e status
coerentes. Codex stays experimental until its live E2E passes; nothing was
published to npm and the version was not changed.

## Artifacts (`artifacts/go-live-v2/`)

```
environment.txt      — round environment + commit provenance
matrix-node24.log    — ci/typecheck/test/build/pack/audit/sbom (Node 24, clean clone)
matrix-node22.log    — ci/typecheck/test/build (Node 22, clean clone)
tarball.sha256       — SHA-256 of rijo-0.1.0-alpha.1.tgz
live-workflow.log    — combined live run (A pass, B first-run failure, Codex gated skip)
scenarioB-rerun.log  — Scenario B isolated re-run from the clean clone: PASS
ci-run.json          — CI 30135389766 (5/5 success) snapshot
sbom.cdx.json        — CycloneDX 1.5 SBOM
```

## Addendum — Codex live cleared (2026-07-25)

The account quota reset. On the certified security commit (`6730be6`, no other
change), both Codex live gates were executed fresh:

| Gate | Result |
|---|---|
| Driver E2E (`RIJO_LIVE_E2E=1`, real `codex exec`, gpt-5.6) | **PASSED** — parsed AgentResult in 35.1s |
| Full turnkey workflow (`RIJO_LIVE_CODEX_E2E=1`): tarball → clean fixture → `rijo new @PLANO.md --host codex --run` | **PASSED** in 384s — a real phase finalized end-to-end (not a quota skip) |

With the same flow now proven live on BOTH hosts, the sole open criterion is
closed and the verdict lifts from `READY_CLAUDE_ONLY` to **`READY`**. Codex is
no longer experimental. Nothing was published to npm.
