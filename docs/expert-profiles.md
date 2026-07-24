# Expert profiles

RIJO can inject a compact, technical lens into an agent's brief — an
**expert profile** — chosen deterministically by the router in
`src/experts/router.ts` from the canonical catalog in
`src/experts/catalog.ts`. Every profile is RIJO-original: its name, mission,
checklist and anti-patterns were written from scratch for this project.

## Conceptual attribution

The general idea of a small set of role-scoped review lenses that can be
attached to an agent task was studied, among other mechanisms, in
BMAD-METHOD during the reference analysis recorded in
`docs/source-analysis.md` and `THIRD_PARTY_NOTICES.md`. RIJO reimplements the
*mechanism* only: its own 10 profiles, its own deterministic router, its own
embed/consult split and its own prompt text. No BMAD name, persona, icon,
menu or prose is reused, and no profile performs roleplay — every profile is
a short, technical checklist, never a character.

## The catalog

Each profile (`src/experts/catalog.ts`) declares:

| Field | Purpose |
|---|---|
| `id` | stable kebab-case identifier; also the adapter file basename |
| `mission` | one-sentence purpose (used verbatim as the adapter `description`) |
| `use_when` / `avoid_when` | when selecting this profile is (in)appropriate |
| `checklist` | short imperative checks the profile applies |
| `anti_patterns` | concrete failure patterns the profile exists to catch |
| `output_contract` | expected shape of the profile's advisory/authoring output |
| `default_tools` / `denied_tools` | tool access implied by the profile |
| `default_write_policy` | `'none'` (advisory) or `'task-scope'` (already-writing role) |
| `token_budget` | soft ceiling used by the router's combined-budget cap |

| id | mission (short) | write policy |
|---|---|---|
| `discovery-analyst` | evidence over invention; fact/hypothesis/gap, primary sources | none |
| `product-manager` | preserve value and closed scope; no smuggled requirements | none |
| `system-architect` | stable/simple tech; explicit trade-offs, boundaries, ops impact | none |
| `ux-product-designer` | flow, hierarchy, states, accessibility, native fidelity | none |
| `senior-software-engineer` | TDD, small diffs, compatibility, no claim without a run | task-scope |
| `technical-writer` | concise, verifiable, synchronized docs; no duplication | none |
| `test-architect` | pyramid by risk; regression, fixtures, evidence over glances | none |
| `security-engineer` | threat boundaries, secrets, authz, supply chain; no hypothetical findings | none |
| `devops-sre` | reproducible build, observability, rollback, failure modes | none |
| `debugger` | reproduce first, hypothesis, isolate cause, regression test | task-scope |

Only `senior-software-engineer` and `debugger` declare `task-scope` write
access, because they are embedded into roles (`worker`, repair `lead`) that
already own a write scope. Every other profile is advisory: it never writes,
it only sharpens the reviewing/authoring lens of the task it is attached to.

## Routing (`routeProfiles`)

`routeProfiles({ role, stage?, requirement_tags?, paths?, high_risk? })`
returns `{ primary, complementary, mode }` — **deterministically**: the same
input always produces the same output, with no randomness and no dependence
on object-key iteration order.

Resolution order:

1. **Stage mapping** (or a role-based fallback when the stage has no entry):
   - `SPEC_READY` / `PLAN` / `PLAN_REVIEW` → `product-manager` + `system-architect`
   - `EXECUTE` → `senior-software-engineer`
   - `CODE_REVIEW` → `test-architect` by default; **never**
     `senior-software-engineer` (a reviewer never inherits the authoral
     profile)
   - `UI_SMOKE` / `JOURNEYS` → `ux-product-designer` + `test-architect`
   - `RESEARCH` / `RESEARCH_DELTA` → `discovery-analyst`
   - `DIAGNOSE` / `REPRODUCE` / `REPAIR` → `debugger`
2. **`CODE_REVIEW` + a `security` tag** swaps the primary from
   `test-architect` to `security-engineer` (complementary becomes
   `test-architect`).
3. **Pure-category path override**: when every path in `paths` is a doc
   (`*.md`) or an infra path (`Dockerfile`, `.github/`, `deploy/`), the
   primary is promoted to `technical-writer` / `devops-sre` and the previous
   primary is kept as a complementary hint. Mixed path sets never override.
4. **A `security` tag** guarantees `security-engineer` is present somewhere
   in the selection, even outside `CODE_REVIEW`.
5. **`researcher` is single-lens**: read-only research always collapses to
   exactly 1 profile — complementary is forced empty regardless of the
   signals above.
6. **Caps**: complementary is capped at 2 (3 profiles total), then the
   combined `token_budget` is capped at 1500 by dropping complementary
   entries from the tail — the primary is never dropped.

`validateProfiles(ids)` checks every id against the catalog and the 3-profile
ceiling, and throws a descriptive error **before** any model call or brief is
built — an unknown profile id is a fail-loud, not a silent skip.

## Embed vs. consult

- **`embed`** (default) — `renderProfileBrief(ids)` renders the selected
  profiles' mission, checklist, anti-patterns and output contract as a
  compact `## Expert guidance` section inside the task's own brief
  (`src/agents/prompts.ts`). This costs no extra model call: the acting agent
  simply reads a sharper set of instructions. Embed is the default because it
  is the cheapest option token-wise.
- **`consult`** — selected automatically when `high_risk: true`.
  `buildConsultAdvisoryTask(profileId, contextNote)` builds a separate,
  read-only `reviewer` task draft (`write_scope: []`, `workspace: null`) that
  returns a short JSON advisory verdict
  (`{ concerns[], recommendations[], severity }`) instead of writing
  anything. Consult costs an extra model call, so it is reserved for
  genuinely high-risk changes.

## Generated adapter artifacts

Both host adapters generate one file per catalog entry, from the **same**
`src/experts/catalog.ts` source — never duplicated content:

- **Claude Code** (`src/adapters/claude.ts`) writes
  `.claude/agents/rijo-expert-<id>.md` with frontmatter `name`, `description`
  (the profile's `mission`), `model` (a concrete Claude model resolved via
  the existing `providers.claude` map — writers use the
  `economical-coding` tier, advisors use `strongest-independent`),
  `maxTurns` (30 for writers, 10 for advisors), `tools` / `disallowedTools`
  (advisors deny `Write`/`Edit`/`Bash`) and `permissionMode` (`acceptEdits`
  for writers, `plan` for advisors — both valid Claude Code permission
  modes). The body is `renderProfileBrief([id])`.
- **Codex** (`src/adapters/codex.ts`) writes `.agents/experts/<id>.toml` —
  TOML was chosen as the format for Codex expert definitions, to match
  Codex's own `config.toml` convention. It carries `model` and
  `reasoning_effort` resolved via `providers.codex`, `sandbox`
  (`workspace-write` for writers, `read-only` for advisors), and the same
  `body` text from `renderProfileBrief([id])` inside a TOML literal
  multi-line string.

`tests/experts.test.ts` asserts both adapters embed the identical mission and
checklist text for every profile, and that every generated `model` value is a
real, concrete model the respective provider table resolves to.
