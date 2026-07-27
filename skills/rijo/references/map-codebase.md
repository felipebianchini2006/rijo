# Map an existing codebase

Use this workflow only for a repository that existed before RIJO.
Do not create a project milestone.

1. Read the current map status.
2. Create a durable read-only mapping task before delegation.
3. Delegate bounded repository areas to native read-only subagents.
4. Use the deterministic map implementation for inventory, hashes, ownership, symbols, dependencies, and receipts.
5. Preserve full, no-op, incremental, query, status, coverage, and recovery behavior.
6. Validate every map artifact.
7. Write or refresh `.rijo/codebase/`.
8. Read `native-results.md`.
9. Record each native subagent response in a result bundle.
10. Run `rijo internal map-codebase --results @.rijo/runtime/native-results.json`.

Fence stale subagent results.
Do not infer facts that the repository does not prove.
