# Resume work

1. Run `node .rijo/bin/rijo.cjs internal recovery`.
2. Run `node .rijo/bin/rijo.cjs internal status --json`.
3. Read `native_workflow` from the status result.
4. Use its operation and operation arguments when its status is `ACTIVE`.
5. Load `references/<operation>.md` for the selected operation.
6. Load `references/native-results.md` when the selected operation uses native subagents.
7. Reuse the existing active workflow marker.
8. Do not run `workflow-open` again for an active marker.
9. Initialize or reuse the native v2 result bundle.
10. Run the selected internal helper with `--results`.
11. Dispatch each pending native request with its exact identity.
12. Append each validated native result to the bundle.
13. Repeat the selected helper until it completes or reports a true blocker.
14. Use `project-init` for an active `new` operation.
15. Use `map-codebase` for an active `map-codebase` operation.
16. Use `ui-import` for an active `ui` operation.
17. Use `next-init` for an active `next` operation.
18. Use `phase-open` for an active `start` operation.
19. Use `qa-record` for an active `test` operation.
20. Use `fix-open` for an active `fix` operation.
21. Use `milestone-finish` for an active `finish` operation.
22. Stop when a required operation argument is unavailable.
23. Inspect durable task records, leases, and the latest verified checkpoint.
24. Fence an expired or stale attempt.
25. Recover deterministic state from canonical Markdown, JSON, events, and Git evidence.
26. Select the workflow recorded by the checkpoint when no active marker exists.
27. Load the selected command reference when no active marker exists.
28. Open the selected workflow once when no active runtime marker exists.
29. Continue from the first incomplete stage.
30. Start a replacement task only within the configured budget.

Do not claim that a native host task was stopped when the host did not provide that capability.
Do not repeat verified work.
Do not use the epoch in `STATE.md` as active authority after a clean clone.
