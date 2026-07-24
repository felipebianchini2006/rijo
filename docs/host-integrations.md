# Host integrations: Claude Code and Codex

RIJO's deterministic orchestrator never runs a model itself. It emits an
`AgentTask` for each unit of work and consumes an `AgentResult`. A **host
integration** is an `AgentRunner` that turns one `AgentTask` into one real CLI
invocation and parses the CLI's output back into an `AgentResult`.

Two real drivers live in `src/hosts/`:

| Driver             | File                     | Backing CLI            |
| ------------------ | ------------------------ | ---------------------- |
| `ClaudeCliRunner`  | `src/hosts/claudeCli.ts` | Claude Code (`claude`) |
| `CodexCliRunner`   | `src/hosts/codexCli.ts`  | Codex (`codex`)        |

Shared building blocks: `src/hosts/spawn.ts` (injectable process spawner),
`src/hosts/models.ts` (pre-spawn model validation), `src/hosts/parse.ts` (prompt
builder + AgentResult extraction), `src/hosts/detect.ts` (availability probe).

Everything is honest: if a CLI is missing, a model is invalid, output is
unparseable, or a call times out, the driver returns an explicit `ok:false`
`AgentResult` with a diagnostic. It never simulates a result.

---

## Turnkey mode (`--host`)

You do not have to write a JSON-RPC loop or bind an `AgentRunner` yourself. Pass
`--host claude` or `--host codex` to `rijo new`, `rijo run`, `rijo check`,
`rijo ui` or `rijo fix` (or set `host.provider` in `.rijo/config.yml`) and RIJO
runs the whole workflow against that CLI:

```bash
rijo run all --host claude
rijo new @PLANO.md --host codex --run     # new + run chained under one lock
rijo check --host claude
```

What happens under the hood (`src/cli/host.ts` → `buildHostExecutor`):

1. **Resolve the provider.** `resolveHostProvider(flag, config)` — the `--host`
   flag wins over `config.host.provider`, which defaults to `none`. An
   unrecognized flag is a usage error (exit code **2**).
2. **Detect the CLI** with `detectClaudeCli` / `detectCodexCli` (`<bin>
   --version`). A missing or failing binary returns a BLOCKED outcome with a
   clear message (exit code **3**) — nothing is simulated.
3. **Build the real controller** (`ClaudeProcessController` /
   `CodexProcessController`) with the project config. Each attempt is a real
   child process (PID-owning), whose `cwd` is that attempt's workspace root — so
   the same write fence as the drivers applies.
4. **Wrap it in a `SupervisedExecutor`** driven by the **full**
   `config.supervisor` policy (real heartbeat, per-role deadlines, and
   replacement budget — not the neutered in-process default), and inject it into
   `WorkflowDeps.executor`.
5. **Run the normal workflow.** Crash recovery still happens under the runtime
   lock; progress and per-attempt heartbeat lines are written to **stderr** so
   stdout stays the machine-readable command result. Exit codes match every
   other command: **0** done, **3** blocked, **1** failed.

The executor is disposed after the run (supervisor timers freed). With provider
`none` the workflow runs exactly as before — the host layer is inert.

> Note: fresh-workspace replacement generations require the workflow dispatch to
> supply a `prepareReplacement` factory. The current `dispatch`/`dispatchBatch`
> path does not, so a failed host attempt is retried in place (with a factual
> failure note) up to `max_replacements_per_task` before the supervisor fences
> it and returns a BLOCKED diagnostic. The replacement **budget** is real either
> way.

---

## How a driver runs one task

1. **Resolve the model.** `task.tier` (set by the orchestrator) indexes
   `config.providers.<provider>` for a concrete `{ model, effort }`. If the
   tier is absent, it falls back to the tier the role maps to in
   `config.models[task.role]`. If neither exists, the task fails with a clear
   `No <provider> provider mapping…` message. See
   `resolveClaudeTier` / `resolveCodexTier` in `src/agents/roles.ts`.
2. **Validate the model before spawning.** An abstract tier string
   (`economical-coding`) or a typo never reaches `--model`; it fails first with
   `Invalid <provider> model…`. See `src/hosts/models.ts`.
3. **Build the prompt.** `buildHostPrompt(task)` wraps the canonical RIJO brief
   (`renderBrief`) and appends a **host response contract**: the agent must end
   its reply with a single fenced `json` block that is a valid `AgentResult`.
4. **Spawn.** `cwd = task.workspace?.root ?? projectRoot`. The workspace is the
   isolated attempt directory; when present the agent must write only there.
5. **Parse.** The `AgentResult` JSON block is recovered from the CLI output
   (`extractAgentResult`, last-valid-block-wins, tolerant of surrounding text).

---

## Claude Code driver

Headless "print mode" (`claude -p`). Flags verified **2026-07-24**:

| Flag / value                       | Purpose                                    | Source |
| ---------------------------------- | ------------------------------------------ | ------ |
| `-p` / `--print`                   | non-interactive run                        | [headless][cc-headless] |
| `--output-format json`             | JSON envelope with a `result` text field   | [headless][cc-headless] |
| `--model <alias\|claude-*>`        | concrete model (opus/sonnet/haiku/fable)   | [cli-reference][cc-cli] |
| `--effort <low\|medium\|high\|…>`  | reasoning effort from the tier             | [cli-reference][cc-cli] |
| `--permission-mode <mode>`         | headless write posture (default `acceptEdits`) | [headless][cc-headless] |
| `--allowedTools <list>`            | auto-approve tools (optional)              | [headless][cc-headless] |
| `--add-dir <path>`                 | read access to project root from a workspace | [cli-reference][cc-cli] |

- **Valid models** (`--model`): aliases `opus`, `sonnet`, `haiku`, `fable`, or a
  `claude-*` id (e.g. `claude-sonnet-5`), or a cloud-provider prefixed id
  (`us.anthropic.claude-*`). Verified in [cli-reference][cc-cli] (2026-07-24).
- **`--effort` values**: `low`, `medium`, `high`, `xhigh`, `max`, `ultracode`
  (availability depends on the model). RIJO tiers only use `low/medium/high`.
  Verified in [cli-reference][cc-cli] (2026-07-24).
- **Output parsing**: prefers the envelope's `structured_output` when present,
  otherwise extracts the JSON block from the `result` text.
- **Capabilities**: `{ subagents: true, parallelism: true, browser: false }`.
  `browser` is **false** — the headless CLI does not drive a browser by default.

## Codex driver

Non-interactive `codex exec`. Flags verified **2026-07-24**:

| Flag / value                          | Purpose                                | Source |
| ------------------------------------- | -------------------------------------- | ------ |
| `codex exec <prompt>`                 | non-interactive run                    | [non-interactive][cx-exec] |
| `--json`                              | JSONL event stream on stdout           | [non-interactive][cx-exec] |
| `--sandbox <mode>`                    | `read-only` \| `workspace-write` \| `danger-full-access` | [non-interactive][cx-exec] |
| `-m` / `--model <gpt-*>`              | concrete model                         | [non-interactive][cx-exec] / [models][cx-models] |
| `-c model_reasoning_effort="<e>"`     | reasoning effort override              | [models][cx-models] |
| `--skip-git-repo-check`               | allow running outside a git repo       | [non-interactive][cx-exec] |

- **Sandbox** is derived per task: `workspace-write` when the task has an
  isolated workspace to write into, `read-only` otherwise (reviewers,
  researchers). Overridable via the `sandbox` option.
- **Reasoning effort** is set with the `-c model_reasoning_effort="…"` config
  override (values `minimal|low|medium|high|xhigh`; RIJO tiers use a subset).
- **Output parsing**: walks the JSONL stream for the assistant's final message,
  extracts the `AgentResult` block, and records the reported `thread_id` in the
  result `summary` when available.
- **Capabilities**: `{ subagents: true, parallelism: true, browser: false }`.

### Corrected model defaults

The previous Codex default `gpt-5.2-codex` is **deprecated**
([models][cx-models], 2026-07-24: "The `gpt-5.2` and `gpt-5.3-codex` models are
deprecated in Codex when you sign in with ChatGPT."). The defaults in
`src/core/schemas/index.ts` were corrected to the current line:

| Model IDs (verified 2026-07-24) | Role in the default map |
| ------------------------------- | ----------------------- |
| `gpt-5.6-sol` (flagship)        | strongest / strongest-independent |
| `gpt-5.6-terra` (balanced)      | balanced-reasoning / economical-coding / economical-browser |
| `gpt-5.6-luna` (fast)           | economical-research |

---

## Role → tier → model map (default config)

| Role         | Tier (`config.models`)   | Claude model  | Codex model     |
| ------------ | ------------------------ | ------------- | --------------- |
| `lead`       | `strongest`              | `opus`        | `gpt-5.6-sol`   |
| `reviewer`   | `strongest-independent`  | `opus`        | `gpt-5.6-sol`   |
| `planner`    | `balanced-reasoning`     | `sonnet`      | `gpt-5.6-terra` |
| `worker`     | `economical-coding`      | `sonnet`      | `gpt-5.6-terra` |
| `researcher` | `economical-research`    | `haiku`       | `gpt-5.6-luna`  |
| `qa`         | `economical-browser`     | `sonnet`      | `gpt-5.6-terra` |

Override any mapping in `.rijo/config.yml` under `providers.claude.<tier>` /
`providers.codex.<tier>`.

---

## Real limitations

- **Browser QA is not provided by these CLI drivers** (`browser: false`). The
  browser-dependent gates (`rijo ui`, `rijo check --production`) degrade
  explicitly to BLOCKED/skipped rather than pretend. Wire a browser-capable
  runner separately if you need it.
- **Permission posture**: Claude runs with `acceptEdits` by default, which
  auto-approves file writes and common fs commands but not arbitrary Bash or
  network. RIJO runs verification commands itself (via its sandboxed shell), so
  agents mainly need write access. Pass `allowedTools` / a different
  `permissionMode` if your tasks need more.
- **Parallelism honesty**: `parallelism: true` means independent CLI processes
  can run concurrently. It does not remove provider-side rate limits; lower
  `limits.max_parallel_agents` if you hit them.
- **Output-format drift**: parsing tolerates surrounding text and unknown JSONL
  event shapes, but a host that changes its envelope schema could still break
  extraction — in which case the driver returns `ok:false`, never a fake pass.
- **Codex reasoning effort** is passed as a `-c` config override, not a
  dedicated flag; if a future Codex release renames the key, update
  `src/hosts/codexCli.ts`.

---

## Running the tests

Deterministic driver tests (no network, no model — fake `Spawner`):

```bash
npx vitest run tests/hosts.test.ts tests/bridge-child.test.ts tests/adapters.test.ts
```

`tests/bridge-child.test.ts` builds the CLI and spawns a **real child process**
(`node dist/cli/index.js serve`), speaking the JSON-RPC bridge over stdio.

### Live E2E (gated, real model calls)

Live tests run **only** when `RIJO_LIVE_E2E=1` **and** the CLI is genuinely
detected on PATH (`describe.runIf`). They are never run in normal CI.

```bash
RIJO_LIVE_E2E=1 npx vitest run tests/live-e2e.test.ts
```

Each host gets one tiny, deterministic task (a researcher asked to return
`{"ping":"pong"}`) with a 180s timeout.

### Report model

Distinguish these outcomes when reporting a live run:

| Status       | Meaning                                                              |
| ------------ | ------------------------------------------------------------------- |
| `not_run`    | `RIJO_LIVE_E2E` not set — test skipped by gate.                     |
| `blocked`    | Gate on but CLI not detected on PATH (`available:false`).           |
| `passed`     | CLI detected, task ran, `AgentResult.ok === true`, payload correct. |
| `failed`     | CLI detected and ran, but `ok:false` or the payload was wrong.      |

Example:

```
host    detected  version              status   notes
claude  yes       2.1.214              passed   payload {"ping":"pong"}
codex   no        —                    blocked  `codex` not on PATH
```

[cc-headless]: https://code.claude.com/docs/en/headless
[cc-cli]: https://code.claude.com/docs/en/cli-reference
[cx-exec]: https://learn.chatgpt.com/docs/non-interactive-mode
[cx-models]: https://learn.chatgpt.com/docs/models
