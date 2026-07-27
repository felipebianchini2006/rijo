# Existing codebase example

RIJO does not rewrite an existing codebase during mapping. The codebase map
records the stack, dependencies, contracts, and executable commands. It also
records current behavior before planning starts.

Use the native workflow:

```text
cd my-existing-project
$rijo map-codebase
$rijo new @NEW-SCOPE.md
$rijo start
```

RIJO applies these rules to an existing codebase:

- Preserve the current stack, patterns, and contracts.
- Change an existing structure only when scope or safety requires the change.
- Record the cost, risk, and migration for each structural change.
- Run safe baseline build and test commands before phase planning.
- Stop when unknown local changes conflict with a task.
- Do not discard or hide local changes.

Use `$rijo next @PLAN-2.md` for a later contract. RIJO compares the approved
plan with the current code and preserves the previous milestone history.

The secondary Command-Line Interface exposes equivalent deterministic map
operations for continuous integration. See
[../../docs/codebase-map.md](../../docs/codebase-map.md).
