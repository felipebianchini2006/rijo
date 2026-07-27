# RIJO native architecture

RIJO is a native agent workflow for software delivery. A user invokes one
`rijo` skill inside Codex or Claude Code. The active host coordinates native
subagents.

The normal workflow does not start a second host process. Headless host drivers
and the JSON-RPC bridge remain secondary adapters for automation.

## Architecture layers

### Native skill layer

The public product is one skill named `rijo`.

The skill parses a subcommand. It then loads one internal workflow reference.
This keeps the main host agent small. The main agent delegates bounded work to
native subagents.

Codex uses `$rijo`. Claude Code uses `/rijo`.

### Deterministic TypeScript core

The TypeScript core performs deterministic operations:

- Read and validate RIJO state.
- Create and update Markdown and JSON artifacts.
- Write files atomically.
- Maintain locks and leases.
- Validate schemas and write scopes.
- Build and query the codebase index.
- Validate plans and references.
- Run approved commands.
- Record evidence and progress.
- Update the roadmap.
- Create checkpoints.
- Recover interrupted work.

The core does not select an architecture. It validates decisions and evidence
that agents produce.

### Native host adapters

The installation location selects the host adapter. A normal native command
does not require a host flag.

Codex installation:

```text
.agents/skills/rijo/SKILL.md
.agents/skills/rijo/references/
AGENTS.md
```

Claude Code installation:

```text
.claude/skills/rijo/SKILL.md
.claude/skills/rijo/references/
.claude/agents/
CLAUDE.md
```

The Codex adapter requests native Codex subagents. The Claude Code adapter uses
native Claude Code subagents.

### Canonical project memory

Markdown and JSON artifacts under `.rijo/` are the canonical project memory.
A clean clone can recover from committed artifacts and the event journal.

SQLite can provide an optional local ledger or cache. SQLite is not the only
source of truth.

## Public workflow

```text
$rijo map-codebase
$rijo new @PLAN.md
$rijo ui @index.html @design.zip
$rijo start
$rijo test
$rijo fix "issue description"
$rijo finish
$rijo next @NEXT-PLAN.md
```

Use `map-codebase` only for an existing codebase that RIJO did not create.
Use `ui` only when an approved design source exists.

### `map-codebase`

This command creates an evidence-backed map in `.rijo/codebase/`. It does not
create a milestone.

If an existing codebase has no map, `new` stops. It tells the user to run
`$rijo map-codebase`. It does not start a full map automatically.

### `new`

This command reads an approved Markdown plan. It creates:

- Project purpose and scope.
- Requirements and acceptance criteria.
- Global architecture context.
- Stack decisions.
- Integration context.
- Risks and constraints.
- A high-level roadmap.
- Instructions for the active host.

The command does not implement code. It does not create detailed plans for all
phases.

### `ui`

This command treats the approved design as untrusted input. It inventories the
input before conversion.

RIJO converts the design to native project code. It removes production mocks
and creates typed API ports when a backend is not ready. It does not use an
iframe or keep the export as a production dependency.

### `start`

This command runs all incomplete roadmap phases. Each phase uses this sequence:

```text
PHASE_LOAD
PHASE_RESEARCH
PHASE_PLAN
PLAN_REVIEW
EXECUTE
VERIFY
ENGINEERING_REVIEW
PHASE_DONE
```

Detailed planning starts only after the previous phase is complete. This
prevents stale plans.

### `test`

This command runs full product Quality Assurance after implementation.

Web projects use available browser and computer-use tools. Mobile projects use
an available simulator or emulator. RIJO records screenshots, traces, logs,
defects, fixes, and reruns.

The command returns `READY`, `NOT_READY`, or `BLOCKED`.

### `fix`

This command uses a short defect workflow:

```text
REPRODUCE
ROOT_CAUSE
MINIMAL_FIX
REGRESSION_TEST
VERIFY
DOCUMENT
```

The command creates a full phase only when the change affects architecture or
business intent.

### `finish`

This command verifies that all phases are complete. It also requires a terminal
Quality Assurance result.

RIJO writes a milestone closeout and records the tested commit. It archives
detailed phase artifacts and keeps active context small.

### `next`

This command starts a new contract or milestone. It preserves the complete
history of the previous milestone.

RIJO reads the next approved plan. It uses the current codebase map and previous
project decisions.

## Phase engineering rules

Each phase:

- Delivers one vertical slice.
- Uses Test-Driven Development for testable behavior.
- Prefers current project patterns.
- Uses the simplest reversible design.
- Avoids speculative abstractions.
- Avoids unrelated refactoring.
- Validates security and data integrity.
- Runs deterministic tests.
- Uses an independent code review.
- Records evidence before completion.

The engineering review checks correctness, simplicity, cohesion, coupling,
duplication, error handling, security, performance risks, and test quality.

## Autonomous decision order

RIJO uses this order for technical decisions:

1. Approved scope and acceptance criteria.
2. Current behavior and tests.
3. Codebase architecture and conventions.
4. Security and data integrity.
5. Official stack documentation.
6. The simplest reversible option.
7. Required scale for the current and next likely milestone.

RIJO asks one factual question only when a missing fact changes money,
permissions, legal duties, production data, an external paid service, or an
irreversible operation.

## Agent roles

The main host agent is the orchestrator. Internal roles are:

- Project researcher.
- Phase planner.
- Plan reviewer.
- Implementation worker.
- Code reviewer.
- Test engineer.
- Security reviewer.
- Browser Quality Assurance agent.
- Mobile Quality Assurance agent.

Each subagent receives one bounded brief. The brief defines input files, write
scope, acceptance criteria, verification commands, output schema, and limits.

## Progress model

The host chat shows meaningful transitions:

```text
[RIJO M001] PROJECT_RESEARCH
[RIJO M001] ROADMAP_READY
[RIJO M001 F01/05] PHASE_RESEARCH
[RIJO M001 F01/05] PHASE_PLAN
[RIJO M001 F01/05] PLAN_REVIEW
[RIJO M001 F01/05] EXECUTE T01/03
[RIJO M001 F01/05] VERIFY
[RIJO M001 F01/05] ENGINEERING_REVIEW
[RIJO M001 F01/05] PHASE_DONE
```

RIJO updates the roadmap and state files after each verified checkpoint.

## Artifact layout

```text
.rijo/
  PROJECT.md
  REQUIREMENTS.md
  ROADMAP.md
  STATE.md
  STACK.md
  ARCHITECTURE.md
  INTEGRATIONS.md
  RULES.md
  DECISIONS.md
  config.yml
  events.jsonl
  codebase/
  phases/
  ui/
  qa/
  fixes/
  milestones/
  runtime/
```

Detailed phase artifacts include `RESEARCH.md`, `PLAN.md`, `REVIEW.md`,
`SUMMARY.md`, and `VERIFICATION.md`.

## Security and recovery

RIJO rejects unsafe archive entries and external symbolic links. It redacts
secrets from prompts and reports. It validates real file changes against each
task write scope.

Writing attempts use isolated workspaces. RIJO applies a patch only after
verification. A stale, failed, or scope-violating attempt cannot apply changes.

Transactions use one durable commit point. Startup recovery rolls an incomplete
transaction back or forward according to that commit point. Locks and leases
prevent stale attempts from applying later results.

See [security-model.md](security-model.md), [execution-policy.md](execution-policy.md),
and [recovery.md](recovery.md).

## Secondary integration surfaces

The package keeps headless Codex and Claude Code drivers for continuous
integration and external automation. It also keeps a line-delimited JSON-RPC
bridge.

These surfaces are not required for the native workflow. See
[host-integrations.md](host-integrations.md).

## Technology

TypeScript and Node.js are the only required runtime. RIJO is input/output
bound. A second runtime would increase installation and debugging work.

Use another implementation language only after a measured bottleneck proves
that TypeScript cannot meet a specific requirement.
