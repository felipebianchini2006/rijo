# Host integrations

RIJO runs as a native skill inside Codex or Claude Code. This is the primary
product interface. The active host uses its native subagents. The normal
workflow does not start another Codex or Claude Code process.

Install the native integration with `npx rijo install`. Use `--codex` or
`--claude` to select a host. Use `--project` or `--user` to select the
installation scope.

## Native Codex integration

The Codex installer creates:

```text
.agents/skills/rijo/SKILL.md
.agents/skills/rijo/references/
AGENTS.md
```

The skill routes each public subcommand to one internal reference. The main
Codex agent remains a thin orchestrator. It delegates bounded tasks to native
Codex subagents.

The native workflow does not call `codex exec`.

## Native Claude Code integration

The Claude Code installer creates:

```text
.claude/skills/rijo/SKILL.md
.claude/skills/rijo/references/
.claude/agents/
CLAUDE.md
```

The skill routes each public subcommand to one internal reference. The main
Claude Code agent delegates bounded work to the installed RIJO agents.

The native workflow does not call `claude -p`.

## Native task contract

Each delegated task contains:

- One objective.
- Required input files.
- An explicit write scope.
- Acceptance criteria.
- Verification commands.
- A required output schema.
- A turn or time limit.

The deterministic core validates state and evidence. It does not select an
architecture. Native agents make technical decisions under the project rules.

## Secondary Command-Line Interface drivers

RIJO keeps headless host drivers for continuous integration and external
automation. These drivers are secondary adapters. They are not the normal user
path.

| Driver | File | Process |
|---|---|---|
| `ClaudeCliRunner` | `src/hosts/claudeCli.ts` | `claude -p` |
| `CodexCliRunner` | `src/hosts/codexCli.ts` | `codex exec` |

Each driver converts one `AgentTask` into one child process. It validates the
selected model before process creation. It parses one `AgentResult` from the
host output.

The drivers return an explicit failure when the host is missing, output is
invalid, or a deadline expires. They do not simulate success.

### Process supervision

The secondary drivers use the same supervisor concepts as the deterministic
core:

- Heartbeat and progress signals.
- Hard deadlines.
- Cancellation acknowledgement.
- Process-tree termination.
- Leases and fencing.
- Fresh identities for replacement attempts.
- Bounded replacement budgets.

Each writing attempt uses an isolated workspace. A task can change only its
declared write scope.

### Provider tiers

Secondary drivers map abstract tiers from `.rijo/config.yml` to concrete host
models. Native skill execution uses the active host model and subagent
configuration.

See [models.md](models.md) for the role and tier model.

## Secondary JSON-RPC bridge

External hosts can use the line-delimited JavaScript Object Notation Remote
Procedure Call bridge over standard input and output:

```bash
npx rijo serve --stdio
```

The bridge supports workflow requests and `agent.runTask` callbacks:

```text
host -> core: workflow request
core -> host: agent.runTask request
host -> core: AgentResult response
core -> host: progress notification
core -> host: workflow result
```

The bridge is an advanced integration surface. A user does not need it for the
native `$rijo` or `/rijo` workflow.

## Test the secondary adapters

Run deterministic adapter tests without a live model:

```bash
npx vitest run tests/hosts.test.ts tests/bridge-child.test.ts tests/adapters.test.ts
```

Live tests require explicit environment gates. They can consume provider quota.
They are not part of normal continuous integration.
