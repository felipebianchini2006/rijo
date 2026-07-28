# Start autonomous implementation

Read `phase-cycle.md`.
Run each incomplete roadmap phase in order.
Continue until all phases are complete or a true blocker occurs.

1. Run `node .rijo/bin/rijo.cjs internal status --json`.
2. Resume an interrupted phase when a valid checkpoint exists.
3. Select the first incomplete roadmap phase.
4. Delegate the bounded phase work with native subagents.
5. Run `node .rijo/bin/rijo.cjs internal workflow-open start` once for this public command.
6. Run `node .rijo/bin/rijo.cjs internal phase-open [NN] --results @.rijo/runtime/native-results.json`.
6. Refresh a stale brownfield map incrementally after verified changes.
7. Select the next incomplete phase.
8. Repeat the cycle.
9. Publish `[RIJO M001] IMPLEMENTATION_COMPLETE` after all phases pass.

Create the detailed plan for one phase only.
Do not plan later phases in detail.
Use a fresh native implementation subagent for each task.
Use parallel work only for disjoint write scopes.
Let the deterministic helper own durable task records, evidence, state transitions, and phase completion.
