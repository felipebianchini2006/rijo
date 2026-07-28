# Native result protocol v2

Use this protocol to transfer native subagent results to the deterministic core.
Do not start a provider process.

Create `.rijo/runtime/native-results.json` with this initial content:

```json
{
  "version": 2,
  "request_file": "native-requests.jsonl",
  "capabilities": {
    "subagents": true,
    "parallelism": false,
    "browser": false
  },
  "results": []
}
```

Run the selected internal helper.
Read each new request from `.rijo/runtime/native-requests.jsonl`.
Copy the complete request to `.rijo/runtime/native-dispatch/<request_id>.json`.
Run `node .rijo/bin/rijo.cjs internal task-dispatch @.rijo/runtime/native-dispatch/<request_id>.json`.
The helper confirms that the durable task record exists before delegation.
Delegate the exact request to one native subagent.
In Codex, set `fork_turns` to `none` when you select an explicit `agent_type`.
In Codex, omit `agent_type` when you inherit the full conversation history.
Record the real host handle when the host provides one.
Run `node .rijo/bin/rijo.cjs internal task-start @.rijo/runtime/native-dispatch/<request_id>.json --host <host> --handle <handle>`.
Run `task-observe` only for useful progress.
Run `task-fail` when the native subagent fails.
Run `task-timeout` when the native subagent exceeds its deadline.
Request host cancellation when that capability exists.
Run `task-cancelled` only after the host confirms cancellation.
Run `task-cancel-unavailable` when the host cannot confirm cancellation.

Copy these identity fields from the request into the result:

```json
{
  "request_id": "nreq_<64 hexadecimal characters>",
  "request_hash": "<64 hexadecimal characters>",
  "logical_task_id": "exact logical task identifier",
  "attempt_id": "exact attempt identifier",
  "generation": 1,
  "lease_id": "exact lease identifier",
  "idempotency_key": "exact idempotency key"
}
```

Do not use a prefix match.
Do not infer a missing identity.
Do not use the current attempt to complete a partial identity.
RIJO rejects stale, reused, altered, and revoked results.

Add the task result with this shape:

```json
{
  "request_id": "nreq_<64 hexadecimal characters>",
  "request_hash": "<64 hexadecimal characters>",
  "logical_task_id": "exact logical task identifier",
  "attempt_id": "exact attempt identifier",
  "generation": 1,
  "lease_id": "exact lease identifier",
  "idempotency_key": "exact idempotency key",
  "ok": true,
  "summary": "Short outcome.",
  "payload": {},
  "files": {},
  "files_written": [],
  "scope_requests": [],
  "decision_proposals": [],
  "artifacts": []
}
```

Put the structured return value in `payload`.
Make `payload` match the request `return_format`.
Do not encode the payload in `summary`.
Use a non-empty string for `summary`.
Use `files` for complete text files.
Encode the text with Unicode Transformation Format 8.
Use project-relative target paths as the keys.
Keep reviewer and researcher `files` empty.

Reference each binary artifact with this shape:

```json
{
  "target_path": "public/logo.png",
  "staged_path": "artifacts/logo.png",
  "sha256": "<64 hexadecimal characters>",
  "size": 1024,
  "media_type": "image/png"
}
```

Keep staged artifacts inside the bundle directory.
Do not put binary bytes in JSON.
RIJO validates each artifact path, hash, size, media type, and write scope.

Put material technical decisions in `decision_proposals`.
RIJO validates these decisions before it applies the patch.
Do not apply a decision proposal directly.

Preserve every validated result entry.
Do not replace a prior result entry.
Do not reorder a prior result entry.
Stage the complete result bundle.
Run `node .rijo/bin/rijo.cjs internal task-complete @.rijo/runtime/native-dispatch/<request_id>.json --host <host> --handle <handle>`.
The completion event does not approve the result.
The deterministic helper approves the result after exact identity and artifact validation.
Run the same helper again.
Repeat until the helper completes or reports a true blocker.

Archive any v1 bundle.
Create a new v2 bundle.
Regenerate the request from the active checkpoint.
Do not use a v1 result in a native workflow.
Use v1 only in an advanced adapter.

Keep all native transport files in `.rijo/runtime/`.
Use Node.js or the host file tools.
Do not invoke Python, Go, or Rust.
