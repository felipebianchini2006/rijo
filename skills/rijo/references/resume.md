# Resume work

1. Run `node .rijo/bin/rijo.cjs internal recovery`.
2. Run `node .rijo/bin/rijo.cjs internal status --json`.
3. Read `native_workflow` from the status result.
4. Use its operation and operation arguments when its status is `ACTIVE`.
5. Use `project-init` for an active `new` operation.
6. Use `map-codebase` for an active `map-codebase` operation.
7. Use `ui-import` for an active `ui` operation.
8. Use `next-init` for an active `next` operation.
9. Use `phase-open` for an active `start` operation.
10. Use `qa-record` for an active `test` operation.
11. Use `fix-open` for an active `fix` operation.
12. Use `milestone-finish` for an active `finish` operation.
13. Stop when a required operation argument is unavailable.
14. Inspect durable task records, leases, and the latest verified checkpoint.
15. Fence an expired or stale attempt.
16. Recover deterministic state from canonical Markdown, JSON, events, and Git evidence.
17. Select the workflow recorded by the checkpoint when no active marker exists.
18. Open the selected workflow once when no active runtime marker exists.
19. Continue from the first incomplete stage.
20. Start a replacement task only within the configured budget.

Do not claim that a native host task was stopped when the host did not provide that capability.
Do not repeat verified work.
Do not use the epoch in `STATE.md` as active authority after a clean clone.
