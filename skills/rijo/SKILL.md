---
name: rijo
description: Run the native RIJO software delivery workflow in Codex or Claude Code.
---

# RIJO

Use the active host session as the lead orchestrator.
Use native subagents for bounded delegated work.
Keep canonical project memory in `.rijo/`.
Use `.rijo/bin/rijo.cjs` for every deterministic helper.
Run every helper from the project root that contains `.rijo/`.
Do not change the working directory to `.rijo/runtime/`.

## Route the command

1. Read `references/command-router.md`.
2. Verify that `.rijo/bin/rijo.cjs` exists.
3. If it is missing, tell the user to run `npx rijo install --project`.
4. Parse the first argument as one of these commands: `map-codebase`, `new`, `ui`, `start`, `test`, `fix`, `finish`, `next`, `status`, or `resume`.
5. Load only `references/<command>.md`.
6. Load another reference only when the selected command requires it.
7. Follow `references/decision-policy.md` when a factual blocker can stop work.
8. Follow `references/language-style.md` for all generated content.

Use English for every host message.
Never use Portuguese in a RIJO message.
Do not inspect the RIJO implementation source.
Do not search the user home directory for RIJO instructions.
Invoke the documented internal helper without probing its help output.
Do not expose private reasoning.
Show only meaningful RIJO stage transitions.
