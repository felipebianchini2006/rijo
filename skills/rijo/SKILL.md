---
name: rijo
description: Run the native RIJO software delivery workflow in Codex or Claude Code.
---

# RIJO

Use the active host session as the lead orchestrator.
Use native subagents for bounded delegated work.
Keep canonical project memory in `.rijo/`.

## Route the command

1. Read `references/command-router.md`.
2. Parse the first argument as one of these commands: `map-codebase`, `new`, `ui`, `start`, `test`, `fix`, `finish`, `next`, `status`, or `resume`.
3. Load only `references/<command>.md`.
4. Load another reference only when the selected command requires it.
5. Follow `references/decision-policy.md` when a factual blocker can stop work.
6. Follow `references/language-style.md` for all generated content.

Use English for every host message.
Do not inspect the RIJO implementation source.
Invoke the documented internal helper without probing its help output.
Do not expose private reasoning.
Show only meaningful RIJO stage transitions.
