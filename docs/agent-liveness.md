# Agent liveness

Liveness in RIJO is a **runtime fact**, never model output. The supervisor
(`src/supervisor/supervisor.ts`, `runAttempt()`) tracks three independent
signals — heartbeat, progress, deadline — and combines them into a bounded
liveness state machine on top of the supervised task states documented in
`docs/agent-supervisor.md`.

## Three signals, three sources

| Signal | Source | Never comes from |
|---|---|---|
| **Heartbeat** | `controller.heartbeat(handle)` — a runtime/process/connection fact: `kill(pid, 0)` for `ProcessController`, promise-pending vs settled for `InProcessController`, `agent.heartbeat` transport notifications for the RPC bridge (`RpcAgentRunner.onHeartbeat`). | Model output. The model never reports "I am alive." |
| **Progress** | `Supervisor.notifyProgress(logicalTaskId)`, wired via `opts.onProgress` in `superviseTask`. The workflow driver calls the emitter it receives — for the RPC bridge this is driven by `agent.progress` transport notifications (`RpcAgentRunner.onProgress`), which is still a host/transport-level signal, not a parsed claim from the model's text. | The model asserting "I made progress" in prose. |
| **Deadline** | `Clock.now()` bounded by `no_progress_timeout_ms[role]` (soft) and `hard_timeout_ms[role]` (hard), both configured per role. | Anything not driven by the injected `Clock` — production uses real wall-clock timers, tests use `FakeClock`. |

## The liveness state machine

Inside `runAttempt()`, a re-arming poll (`scheduleHeartbeat` / `heartbeatTick`)
runs every `heartbeat_interval_ms` while the attempt is `RUNNING` or
`SUSPECT`:

1. Call `controller.heartbeat(handle)`. A thrown error is treated as
   `alive: false`.
2. If alive, record `lastAliveAt = now` and, if the record was `SUSPECT`,
   transition it back to `RUNNING` with `{ recovered: true }` in the event.
3. Compute two independent staleness checks:
   - `heartbeatLost = !alive && now - lastAliveAt > heartbeat_grace_ms`
   - `progressStalled = now - lastProgressAt > no_progress_timeout_ms[role]`
4. If neither is true, reschedule the next poll and keep going.
5. If either is true and the record is still `RUNNING`, transition to
   `SUSPECT` with the triggering reason (`'heartbeat lost'` or
   `'no progress'`).

## SUSPECT and the confirmation probe

Entering `SUSPECT` does not cancel immediately. A short **confirmation
probe** — `controller.query(handle)` raced against
`max(1, floor(heartbeat_grace_ms / 3))` — gives a host that is actually
about to deliver a result one more chance:

- If the probe reports `kind: 'completed'`, the poll reschedules instead of
  cancelling — the result is imminent, so waiting one more heartbeat cycle
  is cheaper than tearing down and replacing a nearly-finished attempt.
- Any other outcome (`running`, `dead`, `disconnected`, `unknown`, or the
  probe itself timing out) begins the cancellation ladder (see
  `docs/host-cancellation.md`) with the original trigger reason
  (`'heartbeat lost beyond grace'` or `'no progress beyond timeout'`).

`SUSPECT` can also resolve by a later heartbeat confirming the host alive
again (step 2 above), returning the record to `RUNNING` without ever
cancelling.

## Hard deadline

Independent of heartbeat/progress, one unconditional timer is armed for
`hard_timeout_ms[role]` when the attempt starts. When it fires it calls
`beginCancel('hard timeout exceeded')` regardless of what heartbeat/progress
currently show — a host that keeps answering heartbeats forever cannot keep
an attempt alive past its hard deadline.

## Example configuration

```yaml
# .rijo/config.yml
supervisor:
  heartbeat_interval_ms: 15000
  heartbeat_grace_ms: 45000
  no_progress_timeout_ms:
    lead: 300000
    planner: 300000
    worker: 300000
    reviewer: 240000
    researcher: 180000
    qa: 300000
  hard_timeout_ms:
    lead: 900000
    planner: 900000
    worker: 1200000
    reviewer: 900000
    researcher: 600000
    qa: 1200000
  cancel_grace_ms: 15000
  hard_kill_grace_ms: 5000
  max_replacements_per_task: 2
  max_total_task_elapsed_ms: 2400000
  replacement_backoff_ms: [1000, 5000]
```

Every key is optional; anything omitted falls back to the default shown
above (`SupervisorConfigSchema`, `src/core/schemas/index.ts`).

## `rijo --status` panel

`statusCli` (`src/cli/main.ts`) reads every non-terminal `TaskRecord` under
`.rijo/runtime/tasks/*.json` (`readSupervisedTasks`, filtering out
`SUCCEEDED`/`FAILED`/`EXHAUSTED`/`CANCELLED`) and renders one block per
active supervised task.

### Human-readable (`rijo --status`)

```text
worker: attempt 2, generation 2
last heartbeat: 4s
last progress: 12s
replacements: 1/2
state: SUSPECT
```

- `attempt N, generation N`: the attempt number and the generation are the
  same value by design — each replacement is a new generation, and the
  generation number *is* the attempt count for that logical task.
- `last heartbeat` / `last progress`: seconds since `last_heartbeat_at` /
  `last_progress_at` (`—` when never recorded).
- `replacements`: `record.replacement_count` out of the configured
  `supervisor.max_replacements_per_task`.
- `state`: the current `SupervisedTaskState`.

### Machine-readable (`rijo --status --json`)

The JSON envelope is `schema_version: 3` and includes `supervisor.tasks[]`
block alongside the pre-existing `runtime`/`checkpoint`/manifest fields —
additive over v1, so older consumers reading only the original top-level
keys keep working:

```jsonc
{
  "schema_version": 3,
  "rijo_version": "0.1.0-alpha.1",
  "initialized": true,
  "active_milestone": "M001",
  "milestones": [ /* ... */ ],
  "runtime": { /* StatusSchema snapshot */ },
  "checkpoint": { /* STATE.md frontmatter */ },
  "supervisor": {
    "tasks": [
      {
        "logical_task_id": "exec-01-T01",
        "role": "worker",
        "state": "SUSPECT",
        "attempt_id": "exec-01-T01#g2-a1b2c3d4",
        "generation": 2,
        "replacements": 1,
        "host": "claude-cli",
        "last_heartbeat_at": "2026-07-24T12:00:04.000Z",
        "last_progress_at": "2026-07-24T11:59:52.000Z",
        "hard_deadline_at": "2026-07-24T12:15:00.000Z",
        "last_error": null
      }
    ]
  }
}
```

`supervisor.tasks[]` includes **every** non-terminal record (the same set
`TaskStore.listNonTerminal()` returns), not just the ones matching the
human-readable panel's filter — the human panel additionally excludes
`CANCELLED` from its own display loop.
