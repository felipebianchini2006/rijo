# Static adapter assets

Adapters are generated from canonical sources by `src/adapters/*` at
`rijo new` time (or `rijo adapters <name>`):

- **claude**: `.claude/skills/rijo-*/SKILL.md` (including `rijo-map`), `.claude/agents/*.md`,
  idempotent `CLAUDE.md` block, `.rijo/adapters/claude/statusline.cjs`
  (reads `.rijo/runtime/status.json`; composition instructions are written to
  `STATUSLINE.md` instead of overwriting an existing statusLine).
- **codex**: `.agents/skills/rijo-*/SKILL.md`, idempotent `AGENTS.md` block
  with chat transition markers; works with or without the Codex App Server.
- **generic**: idempotent `AGENTS.md` block only.

The single source of truth for skill content is the package's `skills/`
directory — there are no divergent per-adapter implementations of the
workflows.
