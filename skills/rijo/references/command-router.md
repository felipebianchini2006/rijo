# Command router

Treat the first argument as the command.
Treat all remaining arguments as command input.

| Command | Required reference | Purpose |
| --- | --- | --- |
| `map-codebase` | `map-codebase.md` | Map a repository that existed before RIJO. |
| `new` | `new.md` | Create project context and a high-level roadmap. |
| `ui` | `ui.md` | Convert an approved design into native project code. |
| `start` | `start.md` | Implement all incomplete roadmap phases. |
| `test` | `test.md` | Run full requirement-derived product validation. |
| `fix` | `fix.md` | Reproduce and repair one defect. |
| `finish` | `finish.md` | Verify and seal a complete milestone. |
| `next` | `next.md` | Create the next milestone from an approved plan. |
| `status` | `status.md` | Report current state without changes. |
| `resume` | `resume.md` | Continue from the latest valid checkpoint. |

Reject an unknown command.
Show the supported command names.
Do not select a provider from command arguments.
Use the active native host.
Use only the documented `node .rijo/bin/rijo.cjs internal` commands for deterministic core work.
Do not call a public workflow from another RIJO workflow.
