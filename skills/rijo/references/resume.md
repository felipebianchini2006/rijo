# Resume work

1. Run `rijo internal recovery`.
2. Run `rijo internal status --json`.
3. Inspect durable task records, leases, and the latest verified checkpoint.
4. Fence an expired or stale attempt.
5. Recover deterministic state from canonical Markdown, JSON, events, and Git evidence.
6. Select the workflow recorded by the checkpoint.
7. Continue from the first incomplete stage.
8. Start a replacement task only within the configured budget.

Do not claim that a native host task was stopped when the host did not provide that capability.
Do not repeat verified work.
