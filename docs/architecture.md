# RIJO architecture

Final decisions for RIJO 0.1.0. Derived from `source-analysis.md`; when the
references diverged the priority order was simplicity > reliability >
automation > token economy > portability > feature count.

## Technical base

- **Language/runtime:** TypeScript on Node.js ≥ 22 (Node 24 "Krypton" is the
  Active LTS as of 2026-07; Node 22 "Jod" is Maintenance LTS — verified at
  nodejs.org/en/about/previous-releases on 2026-07-23, recorded in
  `sources.json` semantics). The reference analysis produced no objective
  advantage for another base: three of four references are Node CLIs, and the
  only Python one (spec-kit) keeps its logic in Markdown templates anyway.
- **Single package**, no monorepo, no database, no mandatory services.
  Canonical state lives in the filesystem and Git.
- **Build:** `tsc` only, ESM, bin shim pattern. No bundler, no postinstall.
- **Dependencies (runtime):** `zod` (schema validation), `yaml` (config/front
  matter), `adm-zip` (ZIP entry reading only; extraction is our own guarded
  code). Everything else is Node stdlib.
- **Dev:** `vitest`, `typescript`, `@types/*`.

## Package layout

```text
src/
  cli/          # arg parsing (node:util parseArgs), command dispatch, panel/status/watch
  core/         # deterministic, LLM-free
    fsx.ts          # atomic writes, hashing, inventory, path containment
    paths.ts        # canonical .rijo layout
    frontmatter.ts  # markdown + YAML front matter (canonical artifact format)
    config.ts       # config.yml load/save (zod-validated)
    locks.ts        # runtime/lock.json, stale detection
    progress.ts     # event bus: events.jsonl -> status.json -> terminal render
    state.ts        # STATE.md checkpoint (verified-only advancement)
    manifest.ts     # manifest.json, hashes, drift detection
    milestones.ts   # lifecycle: create/seal/carryover, MILESTONES.md, transactional swap
    traceability.ts # coverage validation with actionable errors
    plan.ts         # PLAN.md parse/serialize, plan lint, wave computation
    roadmap.ts      # ROADMAP.md + REQUIREMENTS.md parse/serialize
    commands.ts     # injectable shell runner; records command, exit code, summary
    git.ts          # injectable git ops (status, add, commit, tag, rev-parse)
    templates.ts    # fail-loud renderer (throws on unresolved placeholder)
    contextBudget.ts# 24KB auto-load budget enforcement
  security/
    zip.ts          # guarded extraction (traversal, symlink, size, executable checks)
    redact.ts       # secret redaction for prompts/logs/reports
  research/
    cache.ts        # cache.json + sources.json, delta research decisions
  agents/
    protocol.ts     # AgentTask / AgentResult contracts (zod)
    runner.ts       # AgentRunner interface + capability detection + sequential fallback
    roles.ts        # role->tier routing from config.yml
    prompts.ts      # compact prompt builders per role (spec/plan/execute/review/research/qa)
  workflows/
    new.ts          # rijo new (greenfield/brownfield/--next milestone cycle)
    run.ts          # rijo run (13-stage phase state machine)
    ui.ts           # rijo ui (design import pipeline)
    fix.ts          # rijo fix (bounded quick-fix loop)
    check.ts        # rijo check (readiness gates + journeys)
  qa/
    journeys.ts     # derive journeys from requirements; browser interface (injectable)
    readiness.ts    # production-readiness.md generation + READY gate logic
  adapters/
    shared.ts       # marker-block engine, adapter registry
    generic.ts      # AGENTS.md block only
    claude.ts       # .claude/skills, .claude/agents, statusline script, settings composition
    codex.ts        # .agents/skills, AGENTS.md block, chat transition markers
templates/      # canonical artifact + skill templates (shipped in package)
schemas/        # JSON schema exports of the zod schemas (shipped, for external tooling)
skills/         # canonical skill instruction sources (adapter-agnostic)
adapters/       # static adapter assets (statusline script template etc.)
tests/          # unit, integration, golden, e2e (fake agent runner)
fixtures/       # greenfield plan, brownfield mini-project, design zip, malicious zip
docs/
```

## Core decisions

### D1 — Artifacts are the state (all four references)
Truth lives in small Markdown files with YAML front matter. Three tiers:
- **Durable:** `.rijo/*.md`, `milestones/**` — git-committed, only advanced on
  verified checkpoints.
- **Volatile:** `runtime/status.json` — rewritten atomically on every
  transition; gitignored.
- **Audit:** `events.jsonl` — append-only machine log; never loaded into agent
  context.

### D2 — Deterministic sidecar, semantic core (OpenSpec, spec-kit)
The CLI computes everything computable: state, file lists, budgets, coverage,
waves, locks, transitions. Agents receive explicit briefs (objective, canonical
files, code files, write scope, acceptance criteria, verification commands,
return format) and their outputs are validated by code. The core never imports
a provider SDK.

### D3 — Milestones as sealed contracts (GSD milestones + OpenSpec archive)
`rijo new --next` seals the current milestone: every requirement's real status
is checked, incomplete items are classified (carried/debt/cancelled/blocked),
CLOSEOUT.md is written, MILESTONES.md and manifest are updated in the same
logical transaction that creates the next milestone. Historic milestones are
immutable; carried requirements get new IDs with `carried_from`. An annotated
local tag `rijo/M###` is created when configured; never pushed.

### D4 — Phase state machine with evidence gates (BMAD triage + GSD verifier)
`rijo run` drives LOAD → RESEARCH_DELTA → SPEC_READY → PLAN → PLAN_LINT →
PLAN_REVIEW → EXECUTE → VERIFY → CODE_REVIEW → UI_SMOKE → PERSIST → COMMIT →
DONE. PLAN_LINT is deterministic (schema, deps acyclic, coverage, write-scope
conflicts, wave computation). VERIFY runs real commands and records
command/exit/summary — an agent claim is never evidence. CODE_REVIEW is an
independent reviewer (spec + diff + evidence, no author reasoning) with the
8-type triage taxonomy; intent_gap/spec_gap loop back to spec, capped at 2.

### D5 — Bounded loops everywhere (prompt requirement, GSD revision gate)
plan_revisions=2, review_loops=2, qa_fix_loops=2, fix_attempts=2,
max_parallel_agents=4, 2–4 tasks/plan. Exceeding a limit records a blocker in
STATE.md and stops with a precise diagnostic.

### D6 — Provider independence (prompt requirement)
`config.yml` maps six roles to free-form tier strings. The `AgentRunner`
interface is injected; the package ships no live runner binding — adapters
instruct each platform's orchestrator to fill the roles. A `FakeAgentRunner`
drives all tests. Runtimes without subagents run roles sequentially; the
capability flag is honest (never simulated).

### D7 — Progress bus (GSD statusline + OpenSpec status --json)
Every transition: event → status.json (atomic) → terminal line → (checkpoint
only) STATE.md → (material only) short chat message. `rijo --watch` polls the
file locally without model calls. Percentages only from known units.

### D8 — Adapters from one canonical source (OpenSpec markers + spec-kit placeholders)
Skills are authored once in `skills/`; adapters render them into `.claude/skills/`,
`.claude/agents/`, `.agents/skills/` and maintain idempotent
`<!-- RIJO:BEGIN -->…<!-- RIJO:END -->` blocks in CLAUDE.md/AGENTS.md without
touching manual content. The Claude adapter generates a statusline script that
reads `runtime/status.json`; it configures `statusLine` only when none exists,
otherwise writes composition instructions to `.rijo/adapters/claude/STATUSLINE.md`.

### D9 — Security posture
ZIP extraction rejects traversal, absolute paths, symlinks, oversize files and
flags executables/install scripts; nothing from an import is executed before
inspection. Secrets are redacted from prompts/logs/reports by pattern. Workers
are constrained to declared write scopes; paths outside the workspace are
rejected at the fsx layer. `rijo check` never deploys.

### D10 — Distribution
npm package `rijo` (bin `rijo`), `files = [dist, templates, schemas, skills,
adapters]`, SemVer + tags. Recommended: local devDependency pinned in the
lockfile; `npx rijo@<version>` for first runs; global install is convenience
only. `manifest.json` records rijo_version + schema_version; schema mismatch
triggers backup → deterministic migration → validation before any workflow.
CI (documented) runs tests, `npm pack`, installs the tarball into an empty
fixture and executes the packaged CLI — the same flow `tests/pack.e2e.test.ts`
automates locally.

## Context budget

Auto-loaded context per normal execution = RULES.md + STATE.md + active phase
SPEC.md/PLAN.md (+ PROJECT.md/STACK.md/REQUIREMENTS.md only on demand). The
budget checker fails when the automatic set exceeds 24 KB, unless a justification
is recorded in DECISIONS.md. Enforced in `core/contextBudget.ts`, tested in
`tests/context-budget.test.ts`.

## What was deliberately not built

- Monorepo, database, background services, telemetry.
- Multi-IDE installer matrices (2 adapters + generic instead).
- Git-worktree isolation as a requirement (optional capability flag only).
- Free-text requirement merging (namespaced IDs + carried_from instead).
- Interactive prompts (non-interactive by default; blockers stop with diagnostics).
