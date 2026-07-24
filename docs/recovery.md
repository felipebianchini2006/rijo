# Recovery

RIJO assumes the process can die at any moment — mid-supervision, mid-lock,
mid-milestone-transaction. Recovery is what runs on the next start so a
crash never leaves stale in-flight state that could later be misapplied.
Two independent recovery paths run at different scopes: milestone
transactions (`src/core/txn.ts`, reconciled inside `withLock`,
`src/workflows/shared.ts`) and supervised tasks (`src/supervisor/recover.ts`).

## Milestone transaction reconciliation

Every milestone transition (`rijo new --next`) stages its artifacts under
`.rijo/runtime/transactions/<txn-id>/` **before** touching anything else in
the project. The single atomic commit point is a fsync'd `commit.json`
marker (`MilestoneTransaction.commitPoint()`). Nothing outside the runtime
directory is mutated before that marker exists.

`reconcileTransactions(paths)` runs at the top of every `withLock()` body —
i.e. before any workflow observes the tree:

- **No `commit.json`**: the transaction never reached its commit point, so
  the real tree was never touched. It is discarded (rolled back) and the
  transition is fully retryable from scratch.
- **`commit.json` present**: the transaction is guaranteed to complete, so
  its staged files are re-applied deterministically and idempotently
  (`applyStaged`) — this is roll-forward, not rollback.

Either way the transaction directory is removed after reconciliation, so a
crash at **any** injection point (staging a file, the commit marker itself,
applying a file, or the final `finish()`) leaves either zero observable
change or a deterministically completed transition — never a partial one.
`tests/milestone-txn.test.ts` verifies this by injecting a crash after
*every* durable write recorded during one real `--next` run and asserting
both invariants for every single injection point (see `docs/failure-injection.md`).

`STATE.md` is untouched by any of this — it only ever advances on a
**verified checkpoint** (`writeState`/`readState`, `src/core/state.ts`),
never on optimistic progress, so a crash mid-transaction can never leave
`STATE.md` claiming work that didn't actually complete.

## Supervised task reconciliation

`reconcileSupervisedTasks(paths, opts)` (`src/supervisor/recover.ts`) drives
every non-terminal `TaskRecord` (`TaskStore.listNonTerminal()` — everything
except `SUCCEEDED`/`EXHAUSTED`) to a safe, deterministic outcome on startup,
so a dead process's stale attempt can never later apply a result.

### Classification

| From state | Classification | Action |
|---|---|---|
| `QUEUED` | `never_started` | Direct `QUEUED → CANCELLED`. No attempt could ever have existed, so there is nothing to fence or probe. |
| Any other non-terminal state, no recoverable handle (`controllerLookup` returns `null`) | `no_handle` | **Fenced** (lease revoked, workspace invalidated, `termination: 'not_supported'`), then driven to `CANCELLED` via the shortest valid path for its state (`orphanCancel`). |
| Handle found, `query()` → `completed` | `completed` | **Left for the caller to validate.** The record moves to `ORPHANED` (marking it as pending validation) but is *not* fenced — the result may still be genuinely applicable and the caller decides via the normal acceptance checks in `docs/agent-supervisor.md`. |
| `query()` → `running` | `running` | **Fenced.** A running detached attempt from a previous process cannot be re-supervised — there is no live in-memory `Supervisor` state for it — so it is fenced and cancelled rather than left to run unobserved. |
| `query()` → `dead` | `dead` | **Fenced** and cancelled. |
| `query()` → `disconnected` | `disconnected` | **Fenced** and cancelled. |
| `query()` → `unknown`, or the bounded probe times out/throws | `unknown` | **Fenced** and cancelled — an inconclusive probe is treated the same as a confirmed-bad one; recovery never optimistically assumes an unknown attempt is still safe. |

### `REPLACING` is a special case of `orphanCancel`

A record caught in `REPLACING` was between attempts — no live agent process
exists for it at all — so it is driven straight to `EXHAUSTED` rather than
through `ORPHANED → CANCELLED`; there is nothing running to cancel.

### The unknown-with-short-timeout path

For every classification except `never_started` and `no_handle`, recovery
calls `boundedQuery(controller, handle, unknownTimeoutMs)` — a single
`query()` probe raced against a short timeout (default **2000ms**,
`ReconcileOptions.unknownTimeoutMs`). A thrown query or a timeout both
resolve to `{ kind: 'unknown' }`, which — per the table above — is always
fenced. Recovery never blocks long waiting to find out what an attempt is
doing; it makes one bounded attempt to find out and defaults to the safe
(fenced) outcome otherwise.

### Fencing during recovery

`fence()` in `recover.ts` performs the identical operation the supervisor's
own cancellation ladder performs when a host has no confirmed termination
(see `docs/host-cancellation.md`): append the current `lease_id` to
`revoked_leases`, null out `workspace_id`, and record a `fenced` event with
`termination: 'not_supported'`, `workspace_invalidated: true`, and
`recovery: true` so the event log distinguishes recovery-time fencing from
live-supervision fencing.

### Idempotency keys

`idempotency_key` (`sha256(logicalId).slice(0, 32)`, stamped once per
logical task — see `docs/agent-supervisor.md`) is what lets a caller safely
re-dispatch a logical task after recovery: it is stable across every
generation and every restart, so a caller reconciling `left_for_caller`
results or re-queuing a fenced task can always recognize "this is the same
logical unit of work" even though `attempt_id`/`lease_id`/`generation` are
different for each attempt.

### Recovery events

Every record recovery touches emits `recovery_seen` first (state +
generation snapshot), then one of `recovery_completed`,
`state_transition` (with `recovery: true`/`recovery: 'never_started'`/
`recovery: 'completed_pending_validation'` in the event data), or `fenced`
(`recovery: true`). These land in the same `task-events.jsonl` append-only
log as live supervision events — recovery is not a separate audit trail.

## Run lock reconciliation

`.rijo/runtime/lock.json` (`src/core/locks.ts`) is a **renewable lease**, not
a fixed hold:

- **TTL**: `DEFAULT_LOCK_TTL_MS` = 90s. `withLock()` renews it every
  `RECOMMENDED_RENEW_MS` = 30s via an `unref`'d `setInterval`, so a
  long-running workflow body never sees its own lease expire.
- **Reconciliation on acquire** (`acquireLock`), never a blind delete:
  - **Expired** (`expires_at` in the past): the prior holder's
    `active_attempts` are returned as `reclaimedAttempts` and the lease is
    taken over.
  - **Wedged**: a *live* pid (`pidAlive`) whose `heartbeat_at` is stale
    beyond `STALE_HEARTBEAT_TTL_MULTIPLIER` (3) × TTL — the process exists
    but stopped renewing — is also reconciled and taken over.
  - **Otherwise**: the lease is genuinely held; `acquireLock` throws
    `LockError`, whose message explicitly states the lease "will be
    recycled automatically — no manual action needed." Recovery never
    instructs deleting `lock.json` by hand.
- **`reclaimedAttempts`**: when `withLock()` sees a non-empty
  `handle.reclaimedAttempts`, it emits a `lock.reclaimed` progress event
  (`{ attempts: handle.reclaimedAttempts }`) so a later `reconcileSupervisedTasks`
  pass (or a human reading `events.jsonl`) can correlate exactly which
  attempts were orphaned by the previous holder's crash — this is the
  bridge between lock-level and task-level recovery.
- **Release safety**: `release()` refuses to delete the lock while
  `active_attempts` is non-empty unless `force: true` is passed, in which
  case it still deletes the lock and returns the orphaned ids to the
  caller rather than silently discarding them. It also no-ops if the
  on-disk `lease_id` no longer matches this handle's — i.e. if someone
  else already reclaimed it — so a stale holder can never delete a lease
  it no longer owns.

Together, transaction reconciliation, task reconciliation and lock
reconciliation mean a crash at any point in `rijo new`, `rijo run`,
`rijo fix`, `rijo ui`, or `rijo check` leaves the project in a state the
next invocation can always safely resume from — never a state that requires
manual repair.
