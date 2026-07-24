# Commit and evidence model

RIJO commits verified work with **no self-referencing hash**: a commit never
records its own SHA inside itself (impossible without amending, which RIJO
never does), and it never contains a hash it invented rather than one Git
actually produced. The pattern used by `rijo run` (phase completion),
`rijo check --production` (readiness certification), and `rijo fix` (quick
repair) is a small family of two- and three-commit sequences that all follow
the same rule: **code and evidence are separate commits, and the range
between them is checked to contain nothing else.**

## The C1 → C2 → seal pattern (`rijo run`, `workflows/run.ts`)

```
 baseline (dirtyAtStart recorded)
     |
     v
 [verified patches applied from per-task workspaces]
     |
     v
 PERSIST: SPEC.md, PLAN.md, VERIFICATION.md (tested_commit: null,
          evidence_commit: null), SUMMARY.md, REVIEW.md,
          REQUIREMENTS.md, ROADMAP.md, STATE.md, manifest.json
          all written to disk — nothing committed yet
     |
     v
 ┌─────────────── C1 "code commit" ───────────────┐
 │ source files inside authorized task write     │
 │ scopes + ALL phase state artifacts above.      │
 │ Contains NO commit hash anywhere — VERIFICATION│
 │ .md still says tested_commit: null.            │
 └─────────────────────┬───────────────────────────┘
                        │ commitHash = C1
                        v
        VERIFICATION.md rewritten: tested_commit = C1,
        evidence_commit: null
                        │
                        v
 ┌─────────────── C2 "evidence commit" ────────────┐
 │ ONLY allowed metadata paths: VERIFICATION.md,   │
 │ ROADMAP.md, STATE.md, manifest.json,            │
 │ MILESTONES.md index.                            │
 └─────────────────────┬───────────────────────────┘
                        │ evidenceCommit = C2
                        v
        git diffNames(C1, C2) checked: every changed path
        must be in the allowed-metadata list, or BLOCKED
                        │
                        v
        VERIFICATION.md rewritten again: evidence_commit = C2
                        │
                        v
 ┌─────────────── seal commit ─────────────────────┐
 │ ONLY VERIFICATION.md + manifest.json — records   │
 │ C2's own hash, never its own.                    │
 └───────────────────────────────────────────────────┘
                        │
                        v
        git status checked: tree must be clean (nothing RIJO
        touched — including no .rijo/** file — may remain
        uncommitted), or BLOCKED
```

`rijo check --production` (`productionCheck` in `workflows/check.ts`) follows
the identical three-step shape: the gate's `tested_commit` is HEAD as it
already existed (the gate never commits code — it only certifies), the
`evidence` commit adds `production-readiness.md` + the `qa/` evidence
directory (traces, screenshots, server log) and is range-checked against the
tested commit, and the `seal` commit records the evidence commit's own hash
back into the readiness report.

`rijo fix` (`workflows/fix.ts`) uses a **two-step** variant: C1 (the code
change + the fix record, `tested_commit: null`) then C2 (the fix record
rewritten with `tested_commit = C1`, committed alone, range-checked against
C1). There is no third seal step — the fix record has only one field to
backfill (`tested_commit`), so `evidence_commit` is left `null` in the
persisted record; the C2 commit's own hash exists in `git log`, it is simply
never written back into the file. This is a deliberate simplification, not an
oversight — the two-commit and three-commit shapes are the same invariant
(code and evidence separated, range verified) applied to a record with fewer
fields to reconcile.

## Invariants

1. **`tested_commit` is always the commit that was actually tested, never
   invented.** For `run`, it is the C1 hash `git.commitPaths` returned. For
   `check --production`, it is the HEAD the gate checked out and ran against
   — captured *before* any evidence commit exists. A hash is written to a
   report only after `git` has produced it; nothing is guessed or
   pre-computed.
2. **The C1..C2 range may only contain allowed evidence metadata.** After
   every evidence commit, `ctx.git.diffNames(from, to)` is compared against an
   explicit allowlist of paths for that workflow. Any file outside the list
   in that range makes the whole operation `BLOCKED`, even though the commits
   already exist — the workflow does not try to undo them, it stops and
   surfaces the exact illegal paths.
3. **No self-referencing hash inside any single commit.** C1 never contains
   its own hash (it cannot — the hash does not exist until `git commit`
   returns). C2 contains C1's hash, not its own. The seal commit contains C2's
   hash, not its own. This is why three steps exist for `run`/`check` instead
   of one: a single "code + evidence" commit would necessarily either omit
   `tested_commit` (leaving nothing pointing at the tested state) or contain
   its own not-yet-existing hash (impossible without amending).
4. **The tree is clean at the end.** After the final commit of a `run` phase,
   `git status` is re-checked; any dirty file that RIJO touched (including
   any `.rijo/**` path) blocks the outcome. A clean end state is a hard
   postcondition, not a best-effort cleanup.
5. **Pre-existing user edits are an explicit conflict, never silently
   appropriated.** Before a phase runs, `dirtyAtStart` records every file the
   working tree already had modified. If the phase's own authorized changes
   land on one of those paths, the commit step is `BLOCKED` — "Commit or
   revert your local changes, then re-run the phase" — rather than folding
   the user's uncommitted work into a RIJO commit under its authorship.
6. **`vcs: disabled` never invents a hash.** When there is no git repository,
   or `config.git.commit` is `false`, no commit is attempted and the
   evidence/fix record is written with `vcs: disabled` and `tested_commit:
   null` — never a fabricated or reused hash standing in for "no VCS."
7. **Only source paths inside an authorized task's `write_scope`** are staged
   into C1 (`sourceDelta.changed.filter(p => plan.tasks.some(t =>
   pathInScope(p, t.write_scope)))`) — `git add -A` is never used anywhere in
   this model; every commit is built from an explicit path list.

## `fix` and `check` follow the same model, not a parallel one

Both reuse `ctx.git.commitPaths` (explicit path lists, never `-A`) and
`ctx.git.diffNames` (range verification) from the same `GitOps` interface
`run` uses. The differences are only in which artifacts constitute "code" vs.
"evidence" for that workflow:

| Workflow | C1 ("code") | C2 ("evidence") | seal |
|---|---|---|---|
| `run` | task-scoped source + SPEC/PLAN/SUMMARY/REVIEW/VERIFICATION/ROADMAP/REQUIREMENTS/STATE/manifest | VERIFICATION.md, ROADMAP.md, STATE.md, manifest.json, MILESTONES.md index | VERIFICATION.md, manifest.json |
| `check --production` | (not created by check — the already-existing tested commit) | production-readiness.md + `qa/` evidence dir | production-readiness.md |
| `fix` | fixed files + the fix record | the fix record alone | — (two-step only) |

## Proven by

- `tests/commit-model.test.ts` — C1 has no self-hash; C2..seal contain only
  evidence metadata; the tree is clean at the end; pre-existing user edits on
  a task path are an explicit conflict, never appropriated; `fix` follows the
  same model (C1 fix commit, C2 evidence-only, range verified).
- `tests/run-workflow.test.ts` — a commit stages only the files inside the
  authorized write scope (e.g. `src/a.ts`), never a broader sweep.
- `tests/gate.e2e.test.ts` — the production gate resolves `tested_commit` to
  the real checked-out HEAD; a dirty tree stops the gate before anything
  runs; `check --fix` commits the repair and re-certifies against the new
  commit.
- `tests/fix-workflow.test.ts` — the fix record's lifecycle
  (`IN_PROGRESS` → `DONE`/`ESCALATED`) and its commit sequence.
