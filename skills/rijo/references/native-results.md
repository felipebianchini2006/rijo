# Native result bundle

Use this bundle to transfer native subagent results to the deterministic core.
Do not start a provider process.

Write one JSON file with this shape:

```json
{
  "version": 1,
  "request_file": "native-requests.jsonl",
  "capabilities": {
    "subagents": true,
    "parallelism": false,
    "browser": false
  },
  "results": []
}
```

Store this bundle at `.rijo/runtime/native-results.json`.
Run the selected internal helper with the empty bundle.
Read each new request from `.rijo/runtime/native-requests.jsonl`.
Delegate that exact request to a native subagent.
Add the validated result to `results`.
Run the same helper again.
Repeat until the helper completes or reports a true blocker.

Use `match_prefix` instead of `task_id` only for a bounded replacement attempt.
Put project-relative file content in `files` for a writer result.
Keep reviewer and researcher `files` empty.
RIJO validates each result against the current lease, generation, baseline, workspace, and write scope.
RIJO rejects a missing, stale, reused, or out-of-scope result.
Keep all native transport files in `.rijo/runtime/`.
