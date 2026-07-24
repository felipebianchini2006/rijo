# Failure injection

RIJO's resilience claims (bounded supervision, safe recovery, crash-safe
milestone transactions, a resilient RPC bridge) are backed by fault
injection at four levels: deterministic virtual-time simulation, real
child-process termination, real bridge-transport failure, and durable-write
crash injection. This is an inventory of what exists and how to run it —
not new tests.

## `tests/supervisor.test.ts` — deterministic, `FakeClock`-driven (20 scenarios)

No wall-clock time, no real process, no network. A fully scriptable
`FakeController` (implements `HostAgentController`) lets each scenario
control heartbeat, cancel acknowledgement, `query()` status, and result
delivery precisely, while `FakeClock.advance(ms)` fires every due timer in
order and drains microtasks between firings. An `unhandledRejection` guard
runs across the whole file (`afterEach` asserts none occurred).

Seven `describe` blocks, 20 `it` scenarios:

| Suite | Scenarios cover |
|---|---|
| `supervisor — liveness and deadlines` | Host never responds (heartbeat never alive) → cancel + block; a previously-live heartbeat stopping; hard deadline firing despite alive heartbeat; no-progress timeout firing despite alive heartbeat; a slow-but-live-and-progressing attempt is **not** replaced. |
| `supervisor — cancellation ladder` | Clean acknowledged cancel (no fencing); escalation to `forceTerminate` when cancel is never acknowledged; fencing (lease revoked + workspace invalidated) when there is no `forceTerminate` at all. |
| `supervisor — result acceptance and staleness` | A result arriving after cancellation is discarded as `LATE_OR_STALE_RESULT`; the first result is accepted and a duplicate is idempotently discarded; a result carrying a stale lease/generation after replacement is ignored. |
| `supervisor — replacement and exhaustion` | Each replacement gets a fresh identity and a fresh `prepareAttempt` task; exhausting `max_replacements_per_task` returns an actionable `BLOCKED` result. |
| `supervisor — dispose and isolation` | `dispose()` cancels the active attempt with no orphan timers; one stuck task never blocks an independent task from completing. |
| `supervisor — in-process runner controller` | `InProcessController` supervises a `FakeAgentRunner` to success with identity stamped; a non-cancellable in-process attempt that hangs past the hard deadline is fenced, not fake-killed. |
| `supervisor — crash recovery reconciliation` | Reconciliation classification/action scenarios feeding `reconcileSupervisedTasks` (see `docs/recovery.md`). |

Run:

```bash
npx vitest run tests/supervisor.test.ts
```

## `tests/supervisor-process.test.ts` — real child processes

Real Node child processes launched via `ProcessController`, running small
inline scripts (`frozen`: never exits; `lateRespond`: ignores `SIGTERM`,
answers late after being killed; `die`: exits immediately; `good`: healthy
replacement). Four scenarios:

- Detects a **frozen** process and stops it with `SIGTERM` (acknowledged),
  then replaces it.
- **SIGKILLs** a process that ignores `SIGTERM` — proves `forceTerminate`
  actually escalates to a real kill.
- Discards a result a process prints **after** it was cancelled (late
  result) — the `LATE_OR_STALE_RESULT` path against a real process, not a
  simulated one.
- Detects a process that **dies** (pipe closed) and replaces it with a
  healthy one.

Run:

```bash
npx vitest run tests/supervisor-process.test.ts
```

## `tests/supervisor-live.e2e.test.ts` — real Claude Code CLI (gated)

The only suite that spawns a **real Claude Code CLI process** and lets a
real model turn run. Gated by `describe.runIf(LIVE && claude.available)`
where `LIVE = process.env.RIJO_LIVE_E2E === '1'` — never runs in normal CI.

Scenario: a real attempt is told to `sleep 120`, so it is guaranteed to
still be running when the supervisor's hard deadline (5s) fires. The test
asserts, against real receipts on disk:

- The task ends `BLOCKED` within the overall time budget (< 60s wall time).
- The durable record shows `state: EXHAUSTED`, `generation: 2`,
  `replacement_count: 1` — one real replacement happened.
- `task-events.jsonl` contains `CANCELLING`, `REPLACING`, and `EXHAUSTED`.
- **Two** real OS processes were spawned (`pids.length === 2`), and **both**
  are confirmed dead afterward (`process.kill(pid, 0)` throws).
- Neither killed attempt's workspace contains the artifact it was asked to
  write (`DONE.txt`) — proof that a terminated attempt applies nothing.
- No secrets appear in the receipts (`events` does not match
  `/sk-|api[_-]?key|token=/i`).

This is the strongest available proof that supervision is bounded and safe
against a real, uncooperative host — not just against a scriptable fake.

Run:

```bash
RIJO_LIVE_E2E=1 npx vitest run tests/supervisor-live.e2e.test.ts
```

Without `RIJO_LIVE_E2E=1` the file still runs its `describe.skipIf(LIVE)`
counterpart, which just asserts the gate itself is off — so `npx vitest run`
never silently skips-and-passes without recording that it did.

## `tests/bridge-resilience.test.ts` — RPC bridge (`RpcAgentRunner`, `serve`)

Fault injection at the JSON-RPC transport boundary (`src/agents/rpc.ts`,
`src/cli/serve.ts`), using an in-memory fake transport:

- `HOST_TIMEOUT` on host silence, with the timer cleared on settle.
- A per-task `timeoutMs` override is honored.
- Transport **EOF** rejects/resolves **every** pending task with
  `HOST_DISCONNECTED` and clears them all.
- A transport **error** resolves all pendings with `HOST_DISCONNECTED`.
- A **duplicate** response is idempotent: the first response wins, later
  ones are routed to `onLate` instead of double-resolving.
- The `agent.result` notification alias is accepted as equivalent to a
  `runTask` response.
- A response whose **attempt echo diverges** from the supervised pending is
  discarded — the pending stays alive until it times out rather than being
  resolved by a stale/misrouted reply.
- A response for an **unknown or reused id** never resolves any task.
- An `AbortSignal` cancels the task on the host (`agent.cancelTask` sent)
  and resolves `ok:false CANCELLED` locally.
- A signal **already aborted** at dispatch resolves `CANCELLED` without
  ever sending the request.
- `agent.heartbeat`/`agent.progress` notifications reach their registered
  callbacks.
- `listPending()` exposes `id`, `taskId`, `attempt_id`, and `ageMs` for
  diagnostics.

A second `describe` covers the bridge server's own **workflow deadline**:
an in-flight `workflow.*` request that exceeds `workflowDeadlineMs`
responds with `WORKFLOW_DEADLINE_EXCEEDED` and frees the queue for the next
request rather than wedging it.

Run:

```bash
npx vitest run tests/bridge-resilience.test.ts
```

## `tests/locks.test.ts` — run lock as a renewable lease

Covers the lease format, contention (`LockError` never instructs manual
deletion), expired-lease reconciliation (`reclaimedAttempts` returned),
non-expired/non-stale leases correctly **not** reconciled, a wedged live
pid (heartbeat stale beyond 3×TTL) reconciled even though the lease hasn't
formally expired, `renew()` advancing `heartbeat_at`/`expires_at` against an
injected clock, `registerAttempt`/`releaseAttempt` persistence and
idempotency, `release()` requiring `force: true` with active attempts and
returning the orphaned ids, `release()` succeeding without force when no
attempts are active, and `release()` no-op'ing when the on-disk `lease_id`
no longer matches (already reclaimed). A `withLock` describe block covers
background lease renewal keeping a long-running body's lease alive, and the
`lock.reclaimed` event carrying the orphaned attempt ids (see
`docs/recovery.md`).

Run:

```bash
npx vitest run tests/locks.test.ts
```

## `tests/milestone-txn.test.ts` — durable-write crash injection

Injects a real `Error` at **every** durable-write step recorded during one
successful `rijo new --next` transition (`txnHooks.afterWrite`, discovered
by first recording every step of a real run, then re-running the transition
once per recorded step with a crash injected at that exact point):

- For every step **before** the commit marker: the tree shows **zero**
  observable change (`diffTrees` on a snapshot before/after is empty), and
  the transition is fully retryable afterward (a plain retry succeeds).
- For every step **at or after** the commit marker: `reconcileTransactions`
  deterministically completes the transition (roll-forward) — the new
  milestone exists, `CLOSEOUT.md` for the sealed one exists, requirements
  were written.
- After reconciliation either way: no traceability drift
  (`validateStateIntegrity` reports zero `error`-severity issues) and no
  leftover `.rijo/runtime/transactions/` directory.

A second scenario asserts carryover lineage semantics specifically: a
predecessor requirement marked `CARRIED` (never silently `DONE`), and its
successor recorded with `classification: 'CARRYOVER'`, `carried_from`, and
`resolves` pointing back at it — but starting `status: 'PENDING'`, because
lineage existing is not the same claim as resolution being complete.

Run:

```bash
npx vitest run tests/milestone-txn.test.ts
```

## Running everything in this inventory

```bash
npx vitest run \
  tests/supervisor.test.ts \
  tests/supervisor-process.test.ts \
  tests/bridge-resilience.test.ts \
  tests/locks.test.ts \
  tests/milestone-txn.test.ts

# gated, real model calls, real CLI required on PATH:
RIJO_LIVE_E2E=1 npx vitest run tests/supervisor-live.e2e.test.ts
```
