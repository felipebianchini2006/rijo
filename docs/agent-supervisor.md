# Agent supervisor

The supervisor's single guarantee: **no agent attempt can block a workflow
indefinitely.** Liveness is a runtime fact from the host controller — never
model output. Every wait is bounded by an injectable `Clock` and an
`AbortSignal`. Only the current generation holding the current, unrevoked
lease can produce an applicable result. Budgets are configurable with safe
defaults. An exhausted task ends cleanly with an actionable `BLOCKED` result
instead of looping forever.

Source: `src/supervisor/{supervisor,store,clock,recover,processController,runnerController}.ts`,
`src/hosts/controller.ts`, schemas in `src/core/schemas/index.ts`
(`SupervisorConfigSchema`, `SupervisedTaskStateSchema`, `TaskRecordSchema`).

## Modules

| Module | Responsibility |
|---|---|
| `supervisor.ts` (`Supervisor`) | Drives one logical task through attempts to a terminal `AgentResult`. Owns the generation loop, the heartbeat/deadline pollers, result evaluation and the cancellation ladder. |
| `store.ts` (`TaskStore`) | Durable projection (`.rijo/runtime/tasks/<logical-task-id>.json`) and append-only event log (`.rijo/runtime/task-events.jsonl`). Event is always written **before** the projection (`emit` then `write`), so a crash never leaves a state change with no audit trail. |
| `clock.ts` (`Clock`, `SystemClock`, `FakeClock`) | Every timer in the supervisor goes through an injected `Clock`. `SystemClock` uses real, `unref`'d timers; `FakeClock` advances virtual time deterministically for tests (used by all 20 scenarios in `tests/supervisor.test.ts`). |
| `recover.ts` (`reconcileSupervisedTasks`) | Startup reconciliation of non-terminal records left by a crashed process. See `docs/recovery.md`. |
| `processController.ts` (`ProcessController`) | `HostAgentController` for a real child process: liveness is `kill(pid, 0)`, graceful cancel is a real signal, hard termination is `SIGKILL`. Used directly by the Claude/Codex CLI drivers when supervised as OS processes. |
| `runnerController.ts` (`InProcessController`) | Adapts an in-process `AgentRunner` to `HostAgentController`. Deliberately exposes no `forceTerminate` — an in-process call cannot be interrupted, so a stuck attempt is fenced, not faked-killed. |
| `hosts/controller.ts` (`HostAgentController`) | The capability-explicit interface every host driver implements: `start`, `heartbeat`, `requestCancel`, optional `forceTerminate`, `query`, `dispose`. |

## `superviseTask` flow

`Supervisor.superviseTask(task, opts)` always resolves with an `AgentResult`
— it never throws and never hangs.

1. **QUEUED.** A `TaskRecord` is created and persisted (`TaskStore.create`)
   with generation 1 and a fresh attempt identity (`attempt_id`,
   `lease_id`) and the constant `idempotency_key` for this logical task
   (`sha256(logicalId).slice(0, 32)` — see `docs/recovery.md`).
2. **STARTING.** Soft/hard deadlines are computed from `Clock.now()` plus
   `no_progress_timeout_ms[role]` / `hard_timeout_ms[role]`, and the record
   transitions `QUEUED → STARTING` (or `REPLACING → STARTING` for
   replacements). `controller.start()` is called with the attempt task and a
   fresh `AbortController` signal.
3. **RUNNING.** On a successful `start()`, the record transitions to
   `RUNNING` and `runAttempt()` monitors it with bounded pollers: a
   heartbeat/progress loop, a hard-deadline timer, and the host's `result`
   promise — see `docs/agent-liveness.md` for the liveness state machine and
   `docs/host-cancellation.md` for the cancellation ladder.
4. **Terminal per attempt.** `runAttempt()` resolves with `succeeded`,
   `failed`, or `cancelled`. On `succeeded` the loop returns the result
   immediately. On `failed`/`cancelled` the loop falls through to budget
   and replacement handling.
5. **External stop wins over replacement.** If the supervisor was disposed,
   the task was marked disposing, or the caller's `AbortSignal` fired, the
   loop returns a `CANCELLED` result and never replaces.
6. **Budget check.** If `replacement_count >= max_replacements_per_task` or
   elapsed wall time `>= max_total_task_elapsed_ms`, the record transitions
   to `EXHAUSTED` and a `BLOCKED` `AgentResult` is returned (see below).
7. **REPLACING.** Otherwise the record transitions to `REPLACING`
   (`replacement_count` incremented), prior attempt resources are disposed,
   an optional backoff delay is awaited, and a new generation begins at
   step 2 with a fresh identity and a fresh task (see "Replacement policy").

## State matrix

`SupervisedTaskState` (`src/core/schemas/index.ts`) and its valid
transitions, enforced by `assertSupervisedTransition` — any other transition
throws `InvalidSupervisedTransitionError` before an event or write happens:

| From | Valid transitions to |
|---|---|
| `QUEUED` | `STARTING`, `CANCELLED` |
| `STARTING` | `RUNNING`, `FAILED`, `CANCELLING`, `ORPHANED` |
| `RUNNING` | `SUSPECT`, `CANCELLING`, `SUCCEEDED`, `FAILED`, `ORPHANED` |
| `SUSPECT` | `RUNNING`, `CANCELLING`, `SUCCEEDED`, `FAILED`, `ORPHANED` |
| `CANCELLING` | `CANCELLED`, `FAILED`, `ORPHANED` |
| `CANCELLED` | `REPLACING`, `EXHAUSTED` |
| `REPLACING` | `STARTING`, `EXHAUSTED` |
| `SUCCEEDED` | *(terminal)* |
| `FAILED` | `REPLACING`, `EXHAUSTED` |
| `EXHAUSTED` | *(terminal)* |
| `ORPHANED` | `CANCELLING`, `CANCELLED`, `REPLACING`, `EXHAUSTED` |

`SUCCEEDED` and `EXHAUSTED` are the only states `TaskStore.listNonTerminal()`
excludes — every other state still needs supervision (or, for `ORPHANED`,
recovery) after a restart.

## Timeout matrix

Defaults from `SupervisorConfigSchema` (`src/core/schemas/index.ts`),
overridable per project under `supervisor:` in `.rijo/config.yml`:

| Setting | Default | Meaning |
|---|---|---|
| `heartbeat_interval_ms` | `15_000` | Poll cadence for `controller.heartbeat()`. |
| `heartbeat_grace_ms` | `45_000` | How long a lost heartbeat is tolerated before it counts as lost. |
| `cancel_grace_ms` | `15_000` | Bound on waiting for `requestCancel()`'s acknowledgement before escalating. |
| `hard_kill_grace_ms` | `5_000` | Bound on waiting for `forceTerminate()`'s acknowledgement before fencing. |
| `max_replacements_per_task` | `2` | Replacement budget; exceeding it exhausts the task. |
| `max_total_task_elapsed_ms` | `2_400_000` (40 min) | Wall-clock budget across all generations of one logical task. |
| `replacement_backoff_ms` | `[1_000, 5_000]` | Delay before each replacement's fresh attempt (indexed by replacement count, last value repeats past the array end). |

Per-role `no_progress_timeout_ms` (soft deadline — no heartbeat loss needed,
just no `notifyProgress()` calls) and `hard_timeout_ms` (unconditional
cancel regardless of liveness):

| Role | `no_progress_timeout_ms` | `hard_timeout_ms` |
|---|---|---|
| `lead` | 300,000 (5 min) | 900,000 (15 min) |
| `planner` | 300,000 (5 min) | 900,000 (15 min) |
| `worker` | 300,000 (5 min) | 1,200,000 (20 min) |
| `reviewer` | 240,000 (4 min) | 900,000 (15 min) |
| `researcher` | 180,000 (3 min) | 600,000 (10 min) |
| `qa` | 300,000 (5 min) | 1,200,000 (20 min) |

## Attempt identity and lease

Every attempt is stamped with an `AttemptIdentity` (`mkIdentity`,
`supervisor.ts`):

- `attempt_id`: `<logicalId>#g<generation>-<8-char random token>`
- `lease_id`: `lease-<logicalId>-g<generation>-<same token>`
- `generation`: monotonically increasing integer, starting at 1

`idempotency_key` is **constant** for the whole logical task — it is
`sha256(logicalId).slice(0, 32)`, computed once at the top of
`superviseTask` and reused for every generation. It identifies the logical
task across replacements; `attempt_id`/`generation`/`lease_id` identify one
specific attempt within it. `AttemptWorkspace` and the attempt task's
`canonical_baseline_hash` are stamped alongside it in `buildAttemptTask()`.

## Result acceptance

`runAttempt()`'s `evaluate(result)` (used identically for the host's own
`result` promise and for out-of-band delivery via `ingestResult()`) accepts a
result only when **all** of the following hold:

1. **Identity match**: `result.attempt_id === record.attempt_id`,
   `result.generation === record.generation`,
   `result.lease_id === record.lease_id`.
2. **Lease not revoked**: `result.lease_id` is not present in
   `record.revoked_leases`.
3. **State admits completion**: `record.state` is `RUNNING` or `SUSPECT`.

Any other case — mismatched identity, a revoked lease, or a state that
doesn't admit completion (already `CANCELLING`, `CANCELLED`, `SUCCEEDED`,
etc.) — is recorded as a `late_or_stale_result` event with
`disposition: 'LATE_OR_STALE_RESULT'`, the mismatch reason, and both the
result's and the record's expected `attempt_id`/`generation`/`lease_id`. The
result is discarded; nothing it carries is ever applied to the workspace or
the task record. `ingestResult()` applies the same logic when there is no
active in-memory attempt (e.g. after a restart): it evaluates against the
durable record and always treats the delivery as stale/discarded in that
case.

## Replacement policy

- **Backoff**: `replacement_backoff_ms[min(replacementIndex, length-1)]`,
  awaited via the injected `Clock` before the new attempt starts.
- **Budget**: capped by `max_replacements_per_task` (count) and
  `max_total_task_elapsed_ms` (wall time since the first generation
  started). Either limit reached transitions the record to `EXHAUSTED`.
- **What the new attempt receives**: a brand-new `attempt_id`/`lease_id`/
  `generation` from `mkIdentity`; either the caller's `prepareAttempt(
  generation, previousFailure)` result (a fresh task with a **fresh
  workspace**) when provided, or the original task otherwise; and a short
  factual note appended to `task.notes` —
  `[supervisor] previous attempt <n-1> failed: <reason, truncated to 200 chars>`
  (`withFailureNote`).
- **What the new attempt NEVER receives**: the previous attempt's
  scratchpad, patch, or workspace contents. `PreparedAttempt.task` must come
  with a brand-new workspace; the supervisor never reuses or copies the
  prior attempt's working directory. The failure note is the only signal
  carried forward, and it is capped to 200 characters of the last failure
  reason — never the full transcript.
- **Resource cleanup**: the prior attempt's `dispose()` (from
  `PreparedAttempt` or the internal no-op) runs before the new attempt
  starts, best-effort (errors are swallowed — resource release must never
  block the supervision loop).

## `EXHAUSTED` → `BLOCKED`

When the budget is exceeded, `blockedResult()` builds a terminal, `ok:false`
`AgentResult` carrying a diagnostic payload:

```jsonc
{
  "ok": false,
  "summary": "BLOCKED: task <id> exhausted after <n> replacement(s) (<cause>). Last errors: <up to 3 recent>",
  "payload": {
    "diagnostic": {
      "logical_task_id": "<id>",
      "final_state": "EXHAUSTED",
      "cause": "time budget" /* or "replacement budget" */,
      "attempts": /* replacements + 1 */,
      "replacements": /* replacement_count */,
      "last_errors": /* up to 5 most recent failure reasons */
    }
  }
}
```

This is the only way `superviseTask` ends a task that never produced an
accepted success — deterministically, with a bounded number of attempts, and
with enough diagnostic detail (recent failures, cause, attempt count) for a
caller or a human to act on.
