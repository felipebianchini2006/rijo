# RIJO

> A native agent workflow that turns an approved development plan into verified software.

RIJO runs inside Codex or Claude Code. You invoke one `rijo` skill. The active
host coordinates its native subagents. RIJO stores durable project memory in
Markdown and JSON files under `.rijo/`.

RIJO keeps deterministic work in a TypeScript core. The core validates state,
plans, write scopes, evidence, and recovery data. Agents make technical
decisions and implement bounded tasks.

## Status

The current release candidate is `0.2.0-rc.1`.

Do not use this release candidate for unattended client delivery.
The deterministic macOS gates pass.
The final native host certification is incomplete.
See [docs/readiness.md](docs/readiness.md) for the current readiness record.

## Requirements

- macOS.
- Node.js 22 or Node.js 24.
- Git.
- Codex or Claude Code with native subagent support.

## Install

Install RIJO as a local development dependency. This keeps the package version
in your lockfile.

```bash
npm install --save-dev rijo@0.2.0-rc.1
```

Install the native skill:

```bash
npx rijo install
```

Select a host when you do not want automatic host detection:

```bash
npx rijo install --codex
npx rijo install --claude
```

Select the installation scope:

```bash
npx rijo install --project
npx rijo install --user
```

Project scope installs files in the current repository. User scope makes the
skill available to your user account. You can combine one host flag with one
scope flag.

The Codex installer adds the `rijo` skill and its internal references. The
Claude Code installer also adds its internal RIJO agents.

## Quick start

Use `$rijo` in Codex. Use `/rijo` in Claude Code.

For a new project:

```text
$rijo new @PLAN.md
$rijo start
$rijo test
$rijo finish
```

For an existing codebase that RIJO did not create:

```text
$rijo map-codebase
$rijo new @PLAN.md
$rijo start
$rijo test
$rijo finish
```

Use `map-codebase` before `new` only for an existing codebase. The `new`
command does not run a full codebase map.

## Native commands

| Command | Result |
|---|---|
| `map-codebase` | Create or refresh the evidence-backed map for an existing codebase. |
| `new @PLAN.md` | Create project context, requirements, architecture context, and the roadmap. |
| `ui @input` | Import an approved design from an HTML file, a ZIP archive, or a directory. |
| `start` | Plan, implement, verify, and review all incomplete roadmap phases. |
| `test` | Run full product Quality Assurance with a browser or simulator. |
| `fix "description"` | Reproduce and fix a later defect with a bounded workflow. |
| `finish` | Verify and close the current milestone. |
| `next @PLAN.md` | Start the next contract or milestone without losing history. |
| `status` | Show the current project and workflow state. |
| `resume` | Recover an interrupted workflow from durable state. |

The `new` command creates context and a high-level roadmap. It does not
implement source code. RIJO creates each detailed phase plan only when that
phase starts.

## Phase workflow

The `start` command runs this sequence for each incomplete phase:

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

Each phase uses a vertical slice. RIJO prefers existing project patterns and
the simplest reversible design. RIJO records evidence before it marks a phase
complete.

## Project memory

The `.rijo/` directory is the canonical project memory:

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

Markdown and JSON artifacts are portable and reviewable. SQLite can provide an
optional local ledger or cache. SQLite is not the only source of truth.

## Autonomous decisions

RIJO makes technical and reversible decisions without preference questions. It
uses this order:

1. Approved scope and acceptance criteria.
2. Current behavior and tests.
3. Codebase architecture and conventions.
4. Security and data integrity.
5. Official stack documentation.
6. The simplest reversible option.
7. Required scale for the current contract and the next likely milestone.

RIJO asks one factual question only when a missing fact changes money,
permissions, legal duties, production data, an external paid service, or an
irreversible operation.

## Quality and recovery

RIJO enforces explicit write scopes and isolated attempt workspaces. It uses
atomic writes, locks, leases, manifest hashes, and verified checkpoints.
Interrupted work resumes from durable state.

The `test` command runs real user journeys. Web projects use available browser
tools. Mobile projects use an available simulator or emulator. The command
records screenshots, traces, logs, defects, fixes, and reruns. It returns
`READY`, `NOT_READY`, or `BLOCKED`.

## Secondary automation adapters

The native skill is the primary product interface. RIJO also keeps
Command-Line Interface drivers for continuous integration and external
automation. These drivers can start a headless Codex or Claude Code process.
They are not the normal interactive workflow.

RIJO also provides a line-delimited JavaScript Object Notation Remote Procedure
Call bridge for external hosts:

```bash
npx rijo serve --stdio
```

The bridge emits `AgentTask` requests and accepts validated `AgentResult`
responses. See [docs/host-integrations.md](docs/host-integrations.md).

## Development

```bash
npm install
npm run typecheck
npm test
npm pack
```

The test suite uses deterministic fake runners by default. Gated live tests
exercise the secondary host drivers.

## Security and license

Read [SECURITY.md](SECURITY.md) for the operational security policy. Read
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source attribution.

RIJO uses the MIT License.
