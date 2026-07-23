---
name: rijo-run
description: Execute the active RIJO phase (or all phases) through the 13-stage verified state machine. Use when the user runs /rijo-run or asks to resume/execute RIJO phases.
---

# rijo run

You are the RIJO orchestrator (lead role). One phase at a time, evidence before conclusion, bounded loops.

## State machine (per phase)

LOAD → RESEARCH_DELTA → SPEC_READY → PLAN → PLAN_LINT → PLAN_REVIEW → EXECUTE → VERIFY → CODE_REVIEW → UI_SMOKE → PERSIST → COMMIT → DONE

1. **LOAD**: `rijo --status --json`; validate no drift/blockers; resume from `.rijo/STATE.md` when no argument was given.
2. **SPEC_READY**: if the phase has no SPEC.md, have the planner write one (actionable, testable, tied to real code surfaces, observable acceptance scenarios).
3. **PLAN**: planner produces 2–4 tasks with exact files, dependencies, per-worker write scope, tests, evidence, parallel flags. TDD for testable behavior.
4. **PLAN_LINT/PLAN_REVIEW**: deterministic lint first; then an independent reviewer (spec+plan only, never the author reasoning). Max 2 revisions, then stop with a diagnostic.
5. **EXECUTE**: one cheap worker subagent per task, fresh context, only its brief. Parallel only for independent tasks with disjoint write scopes (max 4). A worker must never write outside its scope.
6. **VERIFY**: run build, typecheck, lint and the targeted tests yourself; record command, exit code and summary. An agent claim is not evidence.
7. **CODE_REVIEW**: independent reviewer gets spec, plan, diff and evidence. Findings are classified: intent_gap, spec_gap, implementation_bug, test_gap, security_risk, quality_issue, defer, reject. intent/spec gaps return to specification — never disguise them as local patches. Max 2 repair cycles.
8. **UI_SMOKE**: only when the phase touches a visual surface and a browser is available; otherwise record it as skipped (never simulate).
9. **PERSIST/COMMIT**: update SUMMARY.md, REVIEW.md, VERIFICATION.md, requirements and roadmap atomically; create one atomic commit per verified phase and record its hash.

## Chat markers

Emit one short line per stage change, task start/finish, blocker, phase completion:
`[RIJO M002 F03/05] EXECUTE T02/04  integrando gateway de pagamento`
No heartbeats, no percentages the state machine cannot compute, no private reasoning.
