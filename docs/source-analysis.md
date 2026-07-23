# Source analysis — reference frameworks

Analysis of the four reference repositories, performed before implementing RIJO.
Each mechanism lists: where it was found, the problem it solves, cost, risk, and
the decision (adopt / adapt / discard) with how RIJO reimplements it and the test
that proves the mechanism survived without the ceremony.

Companion machine-readable file: `source-adoption-map.json`.

Priorities applied when repositories diverged: simplicity > reliability >
automation > token economy > portability > feature count.

---

## BMAD-METHOD (v6.10.0, MIT + trademark carve-out)

Skill-based architecture: ~40 self-contained `SKILL.md` directories copied into
IDE-native folders. No runtime engine; prose-as-program plus deterministic
Python/Node helpers.

| Mechanism | Path in repo | Problem solved | Cost | Risk | Decision |
|---|---|---|---|---|---|
| Node CLI installer, multi-IDE matrix | `tools/installer/bmad-cli.js`, `tools/installer/ide/platform-codes.yaml` | one-command bootstrap for ~20 IDEs | very high code surface | high maintenance | **Discard** matrix; RIJO ships 2 adapters (Claude Code, Codex) + generic |
| Research firewall + extract-don't-ingest | `src/core-skills/bmad-deep-recon/SKILL.md` | context shapes questions, never truth; subagents return digests, parent reads JIT | controlled | elaborate pack taxonomy | **Adapt**: RIJO researchers write files; orchestrator reads only summaries; `sources.json` carries claim+url+date |
| Global stable requirement IDs + coverage map | `src/bmm-skills/2-plan-workflows/bmad-prd/assets/prd-template.md`, `epics-template.md` | traceability that survives reorg | near-free | manual drift | **Adopt**: `M###-REQ-###` namespaced per milestone + deterministic coverage validator (`core/traceability`) |
| Flat status ledger YAML | `bmad-sprint-planning/sprint-status-template.yaml` | one scannable state file | very low | renumbering | **Adapt**: ROADMAP.md front matter holds phase/requirement status |
| `.memlog.md` append-only log, atomic write | `src/scripts/memlog.py` | cross-session memory, resume from tail | low | none | **Adapt**: `events.jsonl` (machine log) + `DECISIONS.md` (append-only human log) |
| Verbatim skill copy + manifest + hand-edit preservation | `tools/installer/ide/_config-driven.js` | reinstall without destroying user edits | moderate | complexity | **Adapt**: idempotent `<!-- RIJO:BEGIN/END -->` marker blocks; skills regenerated whole (owned files) |
| Deterministic lint before semantic review | `bmad-architecture/references/reviewer-gate.md`, `scripts/lint_spine.py` | cheap checks before expensive LLM review | zero tokens | none | **Adopt**: `PLAN_LINT` stage runs before `PLAN_REVIEW` |
| Synchronous subagents, spec-only handoff, inline fallback | `bmad-dev-auto/SKILL.md`, `bmad-quick-dev/step-01` | fresh uncontaminated contexts; degrades without subagents | N× tokens | runtime dependency | **Adopt**: `AgentRunner` interface; sequential fallback when parallelism unsupported |
| RED-first TDD + "tests must have actually run" + no expectation-editing | `bmad-dev-story/SKILL.md`, `bmad-dev-auto/step-03` | prevents claimed-done-without-tests | prose-heavy in BMAD | verbosity | **Adopt** principles in compact prompts; evidence = command + exit code recorded by code |
| Review triage taxonomy (`intent_gap`/`bad_spec`/`patch`/`defer`/`reject`) + bounded loop | `bmad-dev-auto/step-04-review.md` | classify findings, loop back to spec when intent is wrong | moderate | reviewer softness | **Adopt**: RIJO `CODE_REVIEW` taxonomy (`intent_gap`, `spec_gap`, `implementation_bug`, `test_gap`, `security_risk`, `quality_issue`, `defer`, `reject`), loop capped at 2 |
| Blast-radius routing (one-shot vs full loop) | `bmad-quick-dev/workflow.md` | right-size ceremony to risk | low | heuristic | **Adopt**: `rijo fix` vs `rijo run`, with explicit escalation criteria |
| Fail-loud template renderer (HALT on missing var) | `bmad-quick-dev/render.py` | never silent-empty substitution | zero tokens | none | **Adopt**: template rendering throws on unresolved placeholder |
| Status-in-frontmatter + baseline commit resume | `bmad-dev-story/SKILL.md` step 4 | crash-safe resume from disk | trivial | none | **Adopt**: STATE.md front matter + baseline commit recorded at milestone open |
| 1500-line "party mode" retrospective | `bmad-retrospective/SKILL.md` | closure/learnings | very high tokens | theater | **Discard**; CLOSEOUT.md is generated deterministically from verified state |
| MIT + TRADEMARK.md pattern | `LICENSE`, `TRADEMARK.md` | open code, protected brand | n/a | n/a | **Adopt pattern**: RIJO is MIT; no BMad marks reused; attribution in THIRD_PARTY_NOTICES.md |

## spec-kit (specify-cli v0.14.x, MIT)

All workflow logic lives in Markdown prompt templates; the Python CLI is a
scaffolding/adapter installer (34 agent formats).

| Mechanism | Path in repo | Problem solved | Cost | Risk | Decision |
|---|---|---|---|---|---|
| Artifact-as-state, checkbox progress `[ ]`→`[X]` | `templates/commands/implement.md`, `tasks.md` | plan = progress tracker = resume checkpoint | zero extra tokens | no in-progress marker | **Adopt**: PLAN.md tasks carry `done` flags in front matter; flipping is deterministic code |
| Deterministic sidecar scripts returning JSON to prompts | `scripts/python/check_prerequisites.py`, `common.py` | path math/numbering out of the LLM | zero tokens | 3-language twins drift | **Adopt** principle; RIJO core is the sidecar (TypeScript only) |
| FR-/SC-/US- ID scheme + capped `[NEEDS CLARIFICATION]` | `templates/spec-template.md` | stable keys + bounded ambiguity | low | prompt bloat | **Adapt**: requirement IDs + low-risk gaps resolved by conservative hypothesis logged in DECISIONS.md |
| Setup→Foundational→per-story→Polish phases, MVP-first | `templates/tasks-template.md` | incrementally deliverable slices | moderate | sample-task leakage | **Adapt**: RIJO phases are vertical slices of value; 2–4 tasks per phase plan |
| Constitution file loaded by convention | `.specify/memory/constitution.md` | one persistent principles file gating all phases | recurring injection | no enforcement | **Adopt**: `RULES.md` (short constitution) always loaded; budget-checked |
| Read-only analyze gate (severity table, ≤50 findings, never auto-edit) | `templates/commands/analyze.md` | catch drift before implementation | token-budgeted | none | **Adapt**: PLAN_LINT (deterministic) + PLAN_REVIEW (bounded LLM) |
| `[P]` parallel markers + exact-file-path task grammar | `templates/tasks-template.md` | safe parallelization heuristics | low | none | **Adopt**: `parallel` flag + `write_scope` per task; disjointness checked in code |
| Tests optional but must fail first; anti-over-claim (`partial`/`not-run` vs `verified`) | `tasks-template.md`, `extensions/bug/README.md` | integrity of evidence | low | opt-in rigor | **Adopt**: TDD flag per task; verification statuses never inferred |
| Append-only converge for brownfield | `templates/commands/converge.md` | reconcile code vs intent without rewriting | moderate | model comprehension | **Adapt**: `rijo new --next` delta analysis classifies NEW/CHANGE/REMOVE/CARRYOVER/UNCHANGED_DEPENDENCY |
| slug-keyed assess/fix/test bug triad | `extensions/bug/` | scoped debugging with audit trail | low | artifact sprawl | **Adapt**: `rijo fix` writes `.rijo/fixes/YYYYMMDD-HHMM-slug.md` |
| Bundle assets into wheel for offline init | `pyproject.toml` force-include | air-gapped scaffold | n/a | sync burden | **Adopt**: templates/schemas/skills/adapters in npm `files` |
| 34-agent adapter hierarchy | `src/specify_cli/integrations/base.py` | write-once run-anywhere | huge code | maintenance | **Discard**; single template source + 2 thin adapters |

## gsd-core-next (@opengsd/gsd-core v1.8.0, MIT)

Mature, heavily-defended system (13+ runtimes, 33 agents, worktree machinery).
The reusable kernel is much smaller than the repo.

| Mechanism | Path in repo | Problem solved | Cost | Risk | Decision |
|---|---|---|---|---|---|
| Disk-writing fresh-context subagents (paths only, confirmations back) | `new-project.md` §6, `agents/gsd-project-researcher.md` | orchestrator context stays lean | 1 spawn per unit | inline-refusal self-heal needed | **Adopt** everywhere: research, exec, review agents write files; orchestrator reads summaries |
| 4 parallel researchers (stack/features/architecture/pitfalls) + synthesizer | `agents/gsd-project-researcher.md`, templates | first-milestone research fan-out | 5 spawns | fixed count | **Adapt**: up to 4 parallel researchers, dynamic count, delta-only on later milestones |
| Category-prefixed requirement IDs + coverage counter | `templates/requirements.md` | greppable contract, no dropped reqs | near-zero | drift | **Adopt** (merged with milestone namespace) |
| Pre-computed waves + `files_modified` conflict detection + per-task atomic commits | `templates/phase-prompt.md`, `agents/gsd-planner.md` | parallelism decided at plan time | moderate | false dep chains | **Adopt**: plan lint computes waves from `depends_on`; write-scope overlap forces sequential |
| STATE.md digest (<100 lines) + `.continue-here.md` | `templates/state.md`, `templates/continue-here.md` | read once, know where we are | low | file drift | **Adapt**: STATE.md front matter is the digest; runtime/status.json is the volatile pointer |
| Plan-checker: goal-backward, revision gate (cap + stall detection), scope-reduction detection | `agents/gsd-plan-checker.md` | catch gaps before execution | 1 spawn/cycle | reviewer softness | **Adapt**: PLAN_REVIEW capped at 2; deterministic lint handles structure |
| Adversarial verifier ("summary is not evidence, read the files") + must_haves 3-level check | `agents/gsd-verifier.md` | task done ≠ goal achieved | 1 spawn/phase | softness | **Adopt**: VERIFY stage runs commands in code; CODE_REVIEW gets spec+diff+evidence, not author reasoning |
| Git-worktree parallel isolation | `execute-phase.md` guards | parallel executor isolation | very high | correctness minefield | **Discard** as requirement; optional when runtime supports it |
| Typed CLI for state files (`gsd_run query …`) | `gsd-core/bin/gsd-tools.cjs` | agents don't grep their own markdown | code to maintain | low | **Adopt** minimal: `rijo --status --json` + protocol scripts |
| Map-codebase: 4 parallel mappers + `last_mapped_commit` drift stamp + secret-scan gate | `gsd-core/workflows/map-codebase.md` | brownfield onboarding | 4 spawns | low | **Adapt**: brownfield detection in `rijo new`; single inventory pass in code + 1 agent for conventions |
| Statusline hook reading planning state | `hooks/gsd-statusline.js` | ambient progress in Claude Code | low | runtime-specific | **Adopt**: Claude adapter statusline script reads `.rijo/runtime/status.json` |
| Milestone lifecycle commands + roadmap collapse | `workflows/complete-milestone.md` | history stays readable | moderate | low | **Adapt**: `rijo new --next` seals milestone; history stays in `milestones/`, archive only for bulky data |
| 13-runtime installer + capability packs | `bin/install.js`, `capabilities/` | generality | enormous | most changesets are fixes here | **Discard** |

## OpenSpec (@fission-ai/openspec v1.6.0, MIT)

Stateless CLI that emits structured instructions; agent executes. CLI never
calls a model. State derived from the filesystem.

| Mechanism | Path in repo | Problem solved | Cost | Risk | Decision |
|---|---|---|---|---|---|
| Stateless CLI computes state + file list; agent executes one unit | `src/core/artifact-graph/instruction-loader.ts`, `src/commands/workflow/instructions.ts` | deterministic work in code, tokens only for judgment | minimal | agent discipline | **Adopt** as RIJO's core split (code for determinism, IA for judgment) |
| Filesystem-derived state, stateless resume | `src/core/artifact-graph/state.ts` | no checkpoint to corrupt | zero | existence ≠ correctness | **Adapt**: RIJO derives from artifacts AND keeps STATE.md checkpoint (verified-only) + events.jsonl for audit |
| Declarative artifact DAG + Kahn topo-sort + status --json | `src/core/artifact-graph/graph.ts` | build order, ready set, blocked reasons | ~160 lines | low | **Adopt**: phase dependency ordering + `rijo --status --json` stable schema |
| Name-as-identity delta specs (ADDED/MODIFIED/REMOVED) | `schemas/spec-driven/schema.yaml`, `src/core/specs-apply.ts` | git-diffable requirement changes, no DB | cheap | merge complexity | **Adapt**: RIJO uses namespaced IDs + `carried_from` instead of text-merging; delta classification at milestone boundary |
| Zod everywhere + dual human/JSON output + typed `{code,message,fix}` errors | `src/core/schemas/*`, `src/core/validation/validator.ts` | machine contracts with fix hints | negligible | low | **Adopt**: zod schemas; `--json` snapshot; validation errors carry fix hints |
| Validate gate: ERROR/WARNING/INFO + `--strict` | `src/commands/validate.ts` | deterministic pre-flight | zero tokens | rule sprawl | **Adopt** minimal core rules (traceability validator) |
| Archive lifecycle: validate-all-before-write, date-stamped move, Windows-safe rename | `src/core/archive.ts` | atomic closure | code-heavy | merge defects | **Adapt**: CLOSEOUT + transactional milestone swap; atomic temp+rename writes |
| Marker-block idempotency for shared files | `src/core/completions/installers/bash-installer.ts` | edit only your own block | trivial | none | **Adopt**: `<!-- RIJO:BEGIN/END -->` in CLAUDE.md/AGENTS.md |
| `{getFilePath, formatFile}` adapter shape | `src/core/command-generation/types.ts` | one content source, N formats | low | fan-out | **Adopt** with 3 adapters only |
| Bin shim + `files` allowlist + tsc-only build + defensive postinstall | `package.json`, `bin/openspec.js`, `build.js` | minimalist distribution | n/a | low | **Adopt** (no postinstall at all) |
| 29-adapter fan-out, telemetry | `src/core/command-generation/registry.ts`, `src/telemetry/` | generality; analytics | high | privacy | **Discard** |

---

## Cross-cutting synthesis

The four repositories converge on five ideas RIJO is built around:

1. **Artifacts are the state.** Progress lives in small versionable files
   (spec-kit checkboxes, OpenSpec file-existence, GSD STATE digest, BMAD
   frontmatter status). RIJO: STATE.md checkpoint (verified-only) +
   runtime/status.json (volatile) + events.jsonl (audit).
2. **Deterministic sidecar, semantic core.** Path math, validation, coverage,
   locks, transitions in code; research/spec/plan/implementation/review in
   agents (spec-kit scripts, OpenSpec CLI, GSD gsd-tools, BMAD render.py).
3. **Fresh contexts that write files.** Subagents receive briefs and paths,
   write artifacts to disk, return one-line confirmations (GSD researchers,
   BMAD recon, spec-kit "dispatch agents").
4. **Bounded adversarial review with triage taxonomy.** Deterministic lint
   first, independent reviewer second, capped loops, classified findings
   (BMAD triage, GSD plan-checker/verifier, spec-kit analyze, OpenSpec validate).
5. **Idempotent adapter generation from one template source.** Marker blocks
   for shared files, whole-file regeneration for owned files (OpenSpec markers,
   BMAD verbatim skills, spec-kit placeholders).

What RIJO deliberately leaves behind: multi-IDE installer matrices (BMAD,
spec-kit, GSD), git-worktree isolation as a requirement (GSD), roleplay/persona
ceremony (BMAD), free-text requirement merging (OpenSpec), telemetry (OpenSpec),
interactive TUIs (all four).

## License compliance

- All four repositories are MIT. RIJO is a conceptual reimplementation; no
  source files were copied verbatim.
- BMAD trademarks (BMad™, BMad Method™, BMad Core™) are explicitly reserved in
  `BMAD-METHOD-main/TRADEMARK.md`; no BMad naming is used in RIJO.
- No reference project names, logos or marks appear as RIJO branding.
- Conceptual attribution is recorded in `THIRD_PARTY_NOTICES.md`.
