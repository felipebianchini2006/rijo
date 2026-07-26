---
name: rijo-map
description: Build, refresh, query, or inspect RIJO's evidence-backed brownfield codebase map. Use when the user runs /rijo-map, asks to map an existing repository, or needs deterministic codebase intelligence before planning.
---

# rijo map

Run the RIJO core command; do not write mapping documents by hand:

```text
rijo map [--full] [--paths src/a,src/b] [--query "term"] [--status] [--host claude|codex]
```

The core chooses full, no-op, or incremental automatically. It requires a clean checkout, never reads sensitive paths, inventories every relevant file deterministically, calculates selected Git history facts, supervises shard agents through the current executor, validates every claim against real path/hash evidence, runs detected baseline commands only in an isolated workspace, and promotes the candidate map transactionally.

Rules:

- Application source is read-only. A mapper or reviewer that changes the controlled checkout is a hard violation.
- Do not ask whether to refresh, reuse, or rebuild. Freshness, missing bases, explicit `--full`, and path scopes determine the operation.
- `--query` and `--status` are local and deterministic; they make no model calls.
- Never load all detailed map documents into a normal planner context. Start with `.rijo/codebase/SUMMARY.md` and query `inventory.json`, `symbols.json`, `surfaces.json`, `dependency-graph.json`, and `claims.json`.
- Preserve the existing architecture by default. Resolve reversible technical gray areas autonomously; only allowed factual blockers may stop the workflow, with one objective question.

Progress stages are:

`MAP_PREFLIGHT → MAP_INVENTORY → MAP_HISTORY → MAP_SHARDS → MAP_SYNTHESIS → MAP_REVIEW → MAP_BASELINE → MAP_COMMIT → MAP_DONE`

Turnkey examples:

```text
rijo map --host codex
rijo map --paths src/auth,packages/contracts --host claude
rijo map --query "validateSession"
rijo map --status
```

The JSON-RPC bridge exposes the same operation as `workflow.map`.
