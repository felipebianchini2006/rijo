# RIJO codebase map

Use `map-codebase` only for a codebase that existed before RIJO. The command
creates an evidence-backed map in `.rijo/codebase/`. It does not create a
project milestone.

Use the native command:

```text
$rijo map-codebase
```

If `new` detects an existing codebase without a map, it stops. It shows the
exact native command above. The `new` command does not run a full map
automatically.

## Map modes

The deterministic core selects one mode:

- `full`: No usable map exists.
- `no-op`: The map matches the relevant tree.
- `incremental`: Git drift or verified changes affect mapped paths.

The core can also query the local inventory, symbols, surfaces, dependencies,
and claims. Local queries do not use a model.

## Pipeline

1. `MAP_PREFLIGHT` resolves the repository root. It requires a clean checkout,
   except for authorized volatile RIJO state.
2. `MAP_INVENTORY` classifies relevant files and records exclusions.
3. `MAP_HISTORY` calculates renames, churn, co-change, migrations, and
   hotspots.
4. `MAP_SHARDS` groups real modules under one owner. Each read-only attempt
   receives one bounded shard.
5. `MAP_SYNTHESIS` preserves unaffected claims and merges validated fragments.
6. `MAP_REVIEW` validates paths, hashes, lines, and symbols.
7. `MAP_BASELINE` runs detected commands when the execution policy permits
   them.
8. `MAP_COMMIT` promotes the candidate through a recoverable transaction.

Sensitive paths are closed by default. RIJO excludes environment files, local
credentials, vendor files, generated files, binaries, large files, and
external symbolic links from agent input.

Mapping agents do not write application code. The core compares the tree before
and after each read-only batch. It blocks any unexpected change.

## Artifacts

The `.rijo/codebase/` directory contains these planning documents:

- `SUMMARY.md`
- `ARCHITECTURE.md`
- `STRUCTURE.md`
- `MODULES.md`
- `CONVENTIONS.md`
- `TESTING.md`
- `APIS.md`
- `DATA.md`
- `INTEGRATIONS.md`
- `OPERATIONS.md`
- `HISTORY.md`
- `CONCERNS.md`

The directory also contains stable JSON indexes:

- `inventory.json`
- `symbols.json`
- `dependency-graph.json`
- `surfaces.json`
- `map-state.json`

`SUMMARY.md` is the default entry point. RIJO loads detailed map files only
when a task needs them. This keeps the automatic context small.

## Incremental refresh

RIJO can refresh the map between phases. It preserves unaffected claims. It
revalidates changed paths and their dependent modules.

A `BLOCKED` map cannot provide planning context. A `PARTIAL` map blocks work
only when a factual gap affects the requested scope.

## Secondary Command-Line Interface

Continuous integration and external automation can use the secondary
Command-Line Interface:

```bash
rijo map --full
rijo map --paths src/auth,packages/api
rijo map --query "validateSession"
rijo map --status
```

These commands expose deterministic map operations. The native
`$rijo map-codebase` or `/rijo map-codebase` command remains the normal user
path.
