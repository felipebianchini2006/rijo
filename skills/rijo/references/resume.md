# Resume work

1. Run `node .rijo/bin/rijo.cjs internal recovery`.
2. Run `node .rijo/bin/rijo.cjs internal status --json`.
3. Inspect durable task records, leases, and the latest verified checkpoint.
4. Fence an expired or stale attempt.
5. Recover deterministic state from canonical Markdown, JSON, events, and Git evidence.
6. Select the workflow recorded by the checkpoint.
7. Reuse the active workflow epoch when the runtime marker exists.
8. Open the selected workflow once when no active runtime marker exists.
9. Use the selected workflow reference and its exact internal helper.
10. Continue from the first incomplete stage.
11. Start a replacement task only within the configured budget.

Do not claim that a native host task was stopped when the host did not provide that capability.
Do not repeat verified work.
Do not use the epoch in `STATE.md` as active authority after a clean clone.
