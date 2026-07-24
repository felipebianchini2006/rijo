# Third-party notices

RIJO is an original implementation. Before it was built, four open-source
frameworks were analyzed as references (see `docs/source-analysis.md`). No
source code, templates or prose were copied from them; the mechanisms below
were reimplemented conceptually. This file records that intellectual lineage
and the licenses of the reference projects.

## Reference projects (conceptual inspiration only)

| Project | License | Concepts studied |
|---|---|---|
| BMAD-METHOD (BMad Code, LLC) | MIT with trademark notice | review triage taxonomy, fail-loud rendering, status-in-frontmatter resume, role-scoped expert/specialist review lenses attached to an agent task (RIJO's own catalog, names, checklists and prose — see `docs/expert-profiles.md`) |
| Spec Kit (GitHub, Inc.) | MIT | artifact-as-state checkboxes, deterministic sidecar scripts, constitution file |
| GSD / gsd-core (Open GSD) | MIT | disk-writing fresh-context subagents, plan waves, statusline, milestone lifecycle |
| OpenSpec (OpenSpec Contributors) | MIT | stateless instruction-emitting CLI, filesystem-derived state, marker-block idempotency, zod validation patterns |

Trademark note: BMad™, BMad Method™ and BMad Core™ are trademarks of BMad
Code, LLC and are not used by RIJO. The names "Spec Kit", "specify", "GSD" and
"OpenSpec" identify their respective projects and are not used as RIJO
branding.

## Runtime dependencies

| Package | License |
|---|---|
| zod | MIT |
| yaml | ISC |
| adm-zip | MIT |
