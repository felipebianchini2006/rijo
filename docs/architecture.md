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
    manifest.ts     # manifest.json, canonical-context hashes, canonicalBaselineHash, drift detection
    migrate.ts      # deterministic schema migration (backup -> transform -> hash refresh -> version last)
    milestones.ts   # lifecycle: create/seal/carryover, MILESTONES.md, transactional swap
    txn.ts          # crash-safe milestone transaction (staging + fsync'd commit point + roll-forward)
    traceability.ts # coverage validation with actionable errors
    plan.ts         # PLAN.md parse/serialize, plan lint, wave computation, task-status transitions
    roadmap.ts      # ROADMAP.md + REQUIREMENTS.md parse/serialize
    scope.ts        # coarse project snapshot/diff + pathInScope (glob/dir scope matching)
    workspace.ts    # AttemptWorkspace: per-attempt copy isolation, real delta, scope validation, atomic apply
    commands.ts     # SystemShellRunner; string-level command allowlist; CommandEvidence
    git.ts          # injectable git ops (status, add, commit, tag, rev-parse, worktree checkout)
    templates.ts    # fail-loud renderer (throws on unresolved placeholder)
    contextBudget.ts# 24KB auto-load budget enforcement
  security/
    execpolicy.ts   # capability-based execution policy: trust, network, env, sandbox (see D12)
    zip.ts          # guarded extraction (traversal, symlink, size, executable, expansion-ratio checks)
    mockscan.ts      # deterministic mock/placeholder scan on real changed files (UI import gate)
    redact.ts       # secret redaction for prompts/logs/reports
  research/
    cache.ts        # cache.json + sources.json, fail-closed volatile-decision validation, compaction
  agents/
    protocol.ts     # AgentTask / AgentResult contracts (zod)
    runner.ts       # AgentRunner interface + capability detection + sequential fallback
    roles.ts        # role->tier routing from config.yml
    prompts.ts      # compact prompt builders per role (spec/plan/execute/review/research/qa)
  workflows/
    new.ts          # rijo new (greenfield/brownfield/--next milestone cycle)
    run.ts          # rijo run (13-stage phase state machine, per-attempt workspaces, C1/C2/seal commits)
    ui.ts           # rijo ui (design import pipeline: extract -> map -> convert in workspace -> verify -> apply)
    fix.ts          # rijo fix (bounded quick-fix loop, isolated repair workspace, C1/C2 commits)
    check.ts        # rijo check (local readiness gates + journeys; --production drives the executable gate)
  qa/
    journeys.ts     # derive journeys from requirements; structured JourneyAction schema
    playwright.ts   # deterministic Playwright spec codegen from structured actions + anti-placeholder lint
    gate.ts         # runProductionGate: exact-commit checkout, reproducible install, real server, real Playwright
    readiness.ts    # decideReadiness: READY only when every gate passes; BLOCKED on missing capability
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
are constrained to declared write scopes, enforced on the real filesystem delta
of an isolated per-attempt copy (D11), never on the agent's self-report. `rijo
check` never deploys. Full detail: `docs/security-model.md` (threat model and
trust boundaries) and `docs/execution-policy.md` (the execution policy itself).

### D10 — Distribution
npm package `rijo` (bin `rijo`), `files = [dist, templates, schemas, skills,
adapters]`, SemVer + tags. Recommended: local devDependency pinned in the
lockfile; `npx rijo@<version>` for first runs; global install is convenience
only. `manifest.json` records rijo_version + schema_version; schema mismatch
triggers backup → deterministic migration → validation before any workflow.
CI (documented) runs tests, `npm pack`, installs the tarball into an empty
fixture and executes the packaged CLI — the same flow `tests/pack.e2e.test.ts`
automates locally.

### D11 — Per-attempt workspace isolation (`core/workspace.ts`)
A worker never writes to the controlled checkout. `AttemptWorkspace.create`
copies the whole project (symlinking `node_modules` read-through instead of
copying it; skipping `.git`/`dist`/`.next`/`coverage` and volatile
`.rijo/{runtime,archive,events.jsonl}`) into
`.rijo/runtime/workspaces/<id>`, snapshotting a content-hash baseline that
includes `.rijo` canonical files and symlinks. After the attempt runs,
`validate()` computes the REAL delta (additions, modifications, removals,
content-hash renames, symlinks) and enforces it against that task's OWN write
scope — never a group union: any `.rijo/**` change must be inside an explicit
`canonicalWriteScope` the core granted for that attempt (`CanonicalWriteError`
otherwise), and no symlink may resolve outside the workspace
(`SymlinkEscapeError`). `applyVerifiedPatch()` re-snapshots the live checkout
and requires every affected path to still match the attempt's creation
baseline; any concurrent change throws `PatchConflictError` with no partial
merge. A failed, lying, timed-out or scope-violating attempt is discarded
whole (`discard()`); orphaned workspaces from a crashed run are wiped at LOAD
before anything resumes. Proven by `tests/workspace.test.ts`,
`tests/isolation.test.ts`, `tests/hardening.test.ts`.

### D12 — Capability-based execution policy (`security/execpolicy.ts`, `core/commands.ts`)
Two gates. `evaluateCommand` (string level) rejects shell metacharacters,
non-allowlisted executables, path-qualified executables and denied
sub-commands (publish/login/token/owner) before anything runs; `git` is
deliberately absent from the allowlist — Git only happens through the typed
`GitOps` layer. `planCommand` (capability level) then decides trust
(`known-script` — a small fixed set like `npm audit`/`--version` checks — vs
`repository-script` — everything that executes project code), network (`none`
by default, `restricted` = loopback only, `enabled` for known-network commands
or an explicit install), a reconstructed environment (PATH rebuilt from the
workspace's own `node_modules/.bin`; `HOME`/`TMPDIR` redirected to scratch
outside the tree; secrets never forwarded by name regardless of
allowlisting), and a sandbox decision. `npx`/`dlx`/`npm exec` are always
blocked. Installation requires an explicit `allowInstall` flag (only the QA
gate sets it) and always appends `--ignore-scripts`. Repository code demands
an OS sandbox: macOS gets a generated Seatbelt profile; a host with no sandbox
and `execution.sandbox: required` (the default) is refused with
`disposition: BLOCKED` — never an unsandboxed fallback unless
`execution.sandbox: approved-unsandboxed` is set explicitly (an auditable
opt-out, recorded in every `CommandEvidence.sandbox`). Full detail:
`docs/execution-policy.md`. Proven by `tests/hardening.test.ts`,
`tests/sandbox.test.ts` (darwin-gated, self-skips elsewhere).

### D13 — Crash-safe milestone transaction (`core/txn.ts`)
`rijo new --next` stages every artifact of a milestone transition under
`.rijo/runtime/transactions/<id>/staged/`; nothing outside that directory is
touched before a single fsync'd `commit.json` marker. Before the marker, a
crash leaves the old state exactly as it was (rollback discards staging).
After the marker, the transaction WILL complete, deterministically and
idempotently, either inline or via `reconcileTransactions()` roll-forward at
the next `withLock` startup. No intermediate state is ever observable outside
`runtime/`. Proven by `tests/milestone-txn.test.ts` (fault injection after
every durable write leaves no observable intermediate state) and
`tests/hardening.test.ts` (a planner failure during `--next` leaves the
previous milestone untouched; a resolved carryover is never carried twice).

### D14 — Executable production gate (`qa/gate.ts`, `qa/playwright.ts`, `qa/journeys.ts`, `workflows/check.ts`)
`rijo check --production` certifies an EXACT commit, not the working tree:
HEAD must be resolvable on a clean tree (the gate's own `qa/traces/` evidence
directory is exempt), a `git worktree` checkout of that commit is materialized
in `.rijo/runtime/gate-<stamp>/`, dependencies install reproducibly (`npm ci`,
lockfile required, lifecycle scripts off), deterministic scripts run inside
the checkout, Playwright specs are generated deterministically from
structured `qa/journeys/<id>.actions.json` files — never free-form prose; a
journey without actions gets no spec, and a spec lint rejects placeholder
markers, body-only assertions or missing requirement links — the application
is started under Seatbelt (loopback-only network) and health-checked, and the
specs run for real across every configured browser × viewport with
traces/screenshots/server log captured as evidence. Any repo change during the
run (HEAD moves, tree dirties outside `qa/traces/`) invalidates the result.
`--fix` reruns the ENTIRE matrix — not just the failing subset — against the
new commit after each repair. Proven by `tests/gate.e2e.test.ts`,
`tests/playwright-gen.test.ts`, `tests/check-workflow.test.ts`.

## Task lifecycle

Every `PlanTask` (`core/schemas/index.ts`) carries an explicit status, never a
bare `done` boolean:

```
PENDING → RUNNING → IMPLEMENTED → VERIFYING → VERIFIED → DONE
   ↑          |           |            |
   +-- FAILED-+-- BLOCKED-+------------+
   (FAILED/BLOCKED both re-enter only at PENDING)
```

`assertTaskTransition` rejects any move not in that table (e.g. `PENDING →
DONE` is a core error, not a silent skip); `done: true` is only ever derived
from `DONE`. This makes resume deterministic and honest: a `RUNNING` task from
a crashed run is reset to `PENDING` (its orphan workspace was already
discarded); a task left `IMPLEMENTED`/`VERIFYING`/`VERIFIED` is re-verified,
never silently promoted to `DONE` on the next `rijo run`. Proven by
`tests/plan-lint.test.ts` (`setTaskStatus` lifecycle enforcement) and
`tests/isolation.test.ts` (interruption at each transition leaves the correct
status and no unverified checkpoint).

## Context budget

Auto-loaded context per normal execution = RULES.md + STATE.md + active phase
SPEC.md/PLAN.md (+ PROJECT.md/STACK.md/REQUIREMENTS.md only on demand). The
budget checker fails when the automatic set exceeds 24 KB, unless a justification
is recorded in DECISIONS.md. Enforced in `core/contextBudget.ts`, tested in
`tests/context-budget.test.ts`.

## What was deliberately not built

- Monorepo, database, background services, telemetry.
- Multi-IDE installer matrices (2 adapters + generic instead).
- Git-worktree-per-task isolation — every attempt gets a mandatory
  filesystem-copy workspace instead (D11), never optional and never a bare
  capability flag; `git worktree` itself is used only for the production
  gate's exact-commit checkout (D14), not for task attempts.
- Free-text requirement merging (namespaced IDs + carried_from instead).
- Interactive prompts (non-interactive by default; blockers stop with diagnostics).
