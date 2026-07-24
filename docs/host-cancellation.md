# Host cancellation

Cancelling a supervised attempt is a graduated escalation, never a single
signal fired and hoped for. `beginCancel()` in `runAttempt()`
(`src/supervisor/supervisor.ts`) drives it; every step is bounded by the
injected `Clock`, and the only thing that ever moves the ladder forward is a
**confirmed receipt** from the host — never an assumption that a request
landed.

## The ladder

```text
CANCELLING
   │
   ▼
requestCancel(handle, reason)  ── raced against cancel_grace_ms ──┐
   │ acknowledged: true                                            │ timeout / acknowledged: false
   ▼                                                                ▼
CANCELLED                                          forceTerminate?(handle, reason) — if the host implements it
                                                          │ raced against hard_kill_grace_ms
                                    ┌─────────────────────┼─────────────────────┐
                                    │ terminated: true                          │ timeout / terminated: false / not implemented
                                    ▼                                           ▼
                                CANCELLED                                   FENCING
                                                                                 │
                                                                                 ▼
                                                                             CANCELLED
```

1. **Enter `CANCELLING`.** If the record is `RUNNING` or `SUSPECT`, it
   transitions to `CANCELLING` with the trigger reason recorded on the
   event. The attempt's `AbortSignal` is deliberately **not** fired here —
   that signal is reserved for the external/dispose hard-stop path, and
   firing it during the graceful ladder would let a controller that maps
   abort → `SIGKILL` skip the graceful step entirely.
2. **`requestCancel`.** Raced against `cancel_grace_ms` (default 15s). Only
   `receipt.acknowledged === true` counts as success — `requested: true`
   alone (the message was sent) is not enough.
3. **`forceTerminate` (if the host implements it).** If not acknowledged and
   `controller.forceTerminate` exists, it's called and raced against
   `hard_kill_grace_ms` (default 5s). A confirmed `terminated: true` is
   recorded as a `force_terminated` event with the reported `method`
   (`'sigterm' | 'sigkill' | 'interrupt' | 'not_supported'`).
4. **Fencing (no confirmed termination).** If neither step confirmed
   termination — including hosts that never expose `forceTerminate` at all,
   like `InProcessController` — the current lease is added to
   `record.revoked_leases`, `record.workspace_id` is set to `null`, and a
   `fenced` event is recorded with `termination: 'not_supported'` and
   `workspace_invalidated: true`. From this point nothing the old attempt
   could ever return can be applied — see the identity checks in
   `docs/agent-supervisor.md`.
5. **`CANCELLED`.** Whichever path was taken, the record transitions to
   `CANCELLED` with `cancel_acknowledged_at`/`finished_at` set, and
   `runAttempt()` resolves with `{ kind: 'cancelled', reason, record }`.

## Receipts

Both receipt types are honest by construction: `acknowledged`/`terminated`
is `true` **only** when the host confirms it, never inferred from the
request merely being sent.

```ts
interface CancelReceipt {
  requested: boolean;
  acknowledged: boolean; // true ONLY on host confirmation
  detail?: string;
}
interface TerminationReceipt {
  terminated: boolean;
  method: 'sigterm' | 'sigkill' | 'interrupt' | 'not_supported';
  detail?: string;
}
```

## Per-host behavior

### `ProcessController` (`src/supervisor/processController.ts`)

The controller behind every real OS-process attempt — including the Claude
Code and Codex CLI drivers when supervised as child processes (see
`tests/supervisor-live.e2e.test.ts`).

- **Heartbeat**: `process.kill(pid, 0)` — a real signal-0 probe, `alive`
  only while it doesn't throw.
- **`requestCancel`**: sends the configured `cancelSignal` (default
  `SIGTERM`) and resolves `{ acknowledged: true }` **only when the child
  process actually exits** (`close` event). If the process ignores the
  signal the promise stays pending until the supervisor's `cancel_grace_ms`
  bound elapses and escalates.
- **`forceTerminate`**: sends `SIGKILL` and resolves `{ terminated: true,
  method: 'sigkill' }` on the same exit-confirmed basis.
- **`query`**: `completed` once the process has exited, `running` while
  `kill(pid, 0)` still succeeds, `dead` when the pid is gone without a
  recorded exit, `unknown` for an unrecognized attempt id.

Proven end-to-end against a **real Claude Code CLI process** in
`tests/supervisor-live.e2e.test.ts`: a stalled turn is hard-deadlined,
`SIGTERM` is sent, the real process is confirmed dead (`process.kill(pid,
0)` throws afterward), and no artifact from the killed attempt lands in its
workspace.

### Claude Code CLI (`src/hosts/claudeCli.ts`)

`ClaudeCliRunner` is an `AgentRunner`, not a `HostAgentController` by
itself — when supervised, it (or an equivalent process launch) runs under
`ProcessController`, so cancellation is the real `SIGTERM`/`SIGKILL` ladder
above. Claude Code's own hook system (`PreToolUse`, `Stop`, etc., see
`.claude/settings.json`) is a separate, host-internal mechanism for
observability and policy — it can complement the supervisor's decisions
(e.g. surfacing intent) but it is **never** the thing that actually stops a
stuck attempt. The hard guarantee always comes from OS-level process
control, not from asking the model to stop.

### Codex CLI (`src/hosts/codexCli.ts`)

Same story as Claude Code: `CodexCliRunner` is an `AgentRunner` driven as an
OS process (`codex exec`), so when supervised it is subject to the same
`ProcessController` `SIGTERM`/`SIGKILL` ladder. `TerminationReceipt.method`
reserves an `'interrupt'` value for a host that can acknowledge a
non-signal-based stop (e.g. an app-server-level turn interrupt), but no
current driver implements it — `docs/host-integrations.md` documents only
the real `codex exec` CLI flags, not an app-server integration, so this
remains an unused type slot rather than a shipped path.

### Hosts with no `forceTerminate` → fencing

`InProcessController` (`src/supervisor/runnerController.ts`) is the
canonical example: an in-process function call cannot be cooperatively
cancelled, and it deliberately declares **no** `forceTerminate` — the
comment in the source calls this "the honest outcome rather than a fake
kill." Its `requestCancel` always resolves `{ acknowledged: false }`. For
any host in this shape, step 4 above (fencing) is not a fallback for an
edge case — it is the **only** way the supervisor can guarantee the old
attempt's eventual result is never applied: the lease is revoked, the
workspace is invalidated, and `record.termination` is recorded as
`'not_supported'`.

## Guarantee this ladder provides

Regardless of which branch fires, `runAttempt()` always settles exactly
once with `{ kind: 'cancelled', ... }`, `beginCancel` is idempotent
(`if (cancelling || settled) return`), and every timer used along the ladder
is cleared on settle — cancellation can never leave an orphan timer or a
double-resolved attempt, and it never blocks longer than
`cancel_grace_ms + hard_kill_grace_ms`.
