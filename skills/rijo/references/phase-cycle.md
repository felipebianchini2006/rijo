# Phase cycle

Run these stages in order:

`PHASE_LOAD → PHASE_RESEARCH → PHASE_PLAN → PLAN_REVIEW → EXECUTE → VERIFY → ENGINEERING_REVIEW → PHASE_DONE`

## PHASE_LOAD

Read the current state and active roadmap phase.
Load only the active phase context.
Load the current codebase map when it exists.

## PHASE_RESEARCH

Research only the phase delta.
Use official sources for volatile facts.
Store checked dates and source links.

## PHASE_PLAN

Create two to four bounded tasks.
Define requirement identifiers, files, write scopes, dependencies, acceptance criteria, tests, evidence, Test-Driven Development requirements, and parallel safety.
Read `active_phase_dir` from `node .rijo/bin/rijo.cjs internal status --json`.
Run `node .rijo/bin/rijo.cjs internal plan-validate @<active_phase_dir>/PLAN.md`.

## PLAN_REVIEW

Use an independent native reviewer.
Do not send planner reasoning to the reviewer.
Allow at most two correction cycles.

## EXECUTE

Create a durable task record before delegation.
Use one fresh native subagent for each task.
Use worktree isolation for writers when available.
Record completion or failure.
Fence stale results.
Replace failed tasks only within the configured budget.
Read `native-results.md`.
Put each bounded native result in the phase result bundle.

## VERIFY

Run real build, lint, type check, unit, integration, and contract commands.
Treat command output and artifacts as evidence.
Run each approved command through `node .rijo/bin/rijo.cjs internal safe-command -- COMMAND`.
Use `node .rijo/bin/rijo.cjs internal safe-command --loopback -- COMMAND` when a local application server must bind to loopback.

## ENGINEERING_REVIEW

Read `engineering-review.md`.
Use an independent native reviewer.
Allow at most two repair cycles.
Run the framework-owned UI smoke after engineering review.

## PHASE_DONE

Write `SUMMARY.md`, `REVIEW.md`, and `VERIFICATION.md`.
Update requirements, roadmap, and state.
Create a verified checkpoint.
Mark changed map paths as stale.

Run `node .rijo/bin/rijo.cjs internal phase-open [NN] --results @.rijo/runtime/native-results.json`.
The helper owns task records, evidence recording, verified state transitions, and phase completion.
