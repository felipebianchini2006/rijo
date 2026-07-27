# Native adapter assets

RIJO generates host files from the canonical sources in `skills/`.

Use `npx rijo install` to install the native assets. Use `--codex` or
`--claude` to select one host. Use `--project` or `--user` to select the
installation scope.

- The Codex adapter installs `.agents/skills/rijo/SKILL.md` and its internal
  references. It also updates the RIJO block in `AGENTS.md`.
- The Claude Code adapter installs `.claude/skills/rijo/SKILL.md`, its internal
  references, and `.claude/agents/*.md`. It also updates the RIJO block in
  `CLAUDE.md`.
- The generic adapter updates the RIJO block in `AGENTS.md`.

The native `rijo` skill is the primary product interface. Compatibility skill
files redirect old command names to the canonical skill.

The Claude Code adapter can install a status-line script at
`.rijo/adapters/claude/statusline.cjs`. The script reads
`.rijo/runtime/status.json`. If a status line already exists, RIJO writes
composition instructions to `STATUSLINE.md`.

The package `skills/` directory is the single source of truth. Adapters do not
contain separate workflow implementations.
