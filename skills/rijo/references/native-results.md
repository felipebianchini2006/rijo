# Native result protocol v2

Use this protocol to transfer native subagent results to the deterministic core.
Do not start a provider process.
Keep the working directory at the project root that contains `.rijo/`.
Inspect runtime files without changing the working directory to `.rijo/runtime/`.

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
  "workflow_epoch": "wep_<64 hexadecimal characters>",
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
Do not reuse an epoch from a terminal public command.
Do not infer a missing identity.
Do not use the current attempt to complete a partial identity.
RIJO rejects stale, reused, altered, and revoked results.

Add the task result with this shape:

```json
{
  "workflow_epoch": "wep_<64 hexadecimal characters>",
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
  "artifacts": [],
  "preserved_files": [],
  "deleted_paths": [],
  "renames": []
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
Return a non-empty file delta for each successful writer task.
Do not report writer success with empty file fields.

Use `preserved_files` for a delayed result from an assigned workspace.
Copy `workspace_id` from the original request.
Set `baseline_sha256` to the secure hash of the file before the task.
Set `baseline_sha256` to `null` when the task created the file.
Set `sha256` to the secure hash of the completed file.
Use this exact shape:

```json
{
  "target_path": "src/feature.ts",
  "sha256": "<64 hexadecimal characters>",
  "workspace_id": "ws-exec-01-T01-example",
  "baseline_sha256": "<64 hexadecimal characters>"
}
```

RIJO reads the file from the exact retained workspace.
RIJO validates the file against its workspace baseline.
RIJO copies the verified bytes into the current workspace.
RIJO rejects a preserved file with no baseline delta.

Use `deleted_paths` for each explicit file deletion.
Provide the secure hash of the file before deletion.
Use this exact shape:

```json
{
  "path": "src/obsolete.ts",
  "sha256": "<64 hexadecimal characters>"
}
```

Use `renames` for each explicit file rename.
Provide the source path.
Provide the target path.
Provide the secure hash of the source file.
Use this exact shape:

```json
{
  "source_path": "src/old-name.ts",
  "target_path": "src/new-name.ts",
  "source_sha256": "<64 hexadecimal characters>"
}
```

Keep all operation paths relative to the project root.
Use forward slashes in every operation path.
Keep every operation path inside the request write scope.
List every changed source and target path in `files_written`.

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
Preserve `active_workflow_epoch` after the helper adds it.
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
