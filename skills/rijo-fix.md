---
name: rijo-fix
description: Quick verified correction flow — reproduce, root-cause, minimal fix, regression test, atomic commit. Use when the user runs /rijo-fix or reports a bug to fix quickly.
---

# rijo fix

Fast correction without formal phase planning. Never a hidden version of rijo run.

1. `rijo fix "description"` creates the record in `.rijo/fixes/YYYYMMDD-HHMM-slug.md`.
2. Read state, rules and the related code surfaces only.
3. **Reproduce the problem before editing anything.** Two attempts max; if it cannot be reproduced, escalate.
4. Formulate hypotheses; test the most likely one with evidence.
5. Identify the root cause; apply the smallest coherent fix.
6. Add a regression test when technically possible (justify when not).
7. Run the targeted tests and affected regressions; record command + exit code.
8. Create one atomic verified commit; close the record with symptom, cause, fix, evidence and residual risk.

## Escalate to a normal phase when

- the fix needs architectural change, the scope grows, a dangerous migration appears,
- there is broad security impact, the problem resists 2 reproduction attempts,
- or the fix would change intent/business rules.
Maximum 2 quick attempts before escalating.

## Turnkey host mode

To run this flow autonomously against your own CLI, invoke the turnkey command instead of hand-rolling a protocol loop: `rijo fix "description" --host claude` (or `--host codex`, or set `config.host.provider`). RIJO detects the host (a missing CLI BLOCKS), supervises every attempt and prints progress to stderr. `npx rijo serve --stdio` remains available as the advanced JSON-RPC API for external hosts.
