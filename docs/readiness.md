# Native readiness record

## Release

- Version: `0.2.0-rc.1`
- Platform: macOS
- Status: `NOT_READY`
- Policy: ASD-STE100-inspired controlled English

RIJO now uses one native `rijo` skill.
The active Codex or Claude Code session is the lead orchestrator.
The native workflow does not start a nested host process.
The TypeScript core owns deterministic state, validation, evidence, and recovery.

## Passed gates

- The Node.js 22 deterministic matrix passes on macOS.
- The Node.js 24 deterministic matrix passes on macOS.
- Type checking passes.
- The build passes.
- The production dependency audit reports no vulnerability.
- The installer creates a project-local launcher.
- The installer vendors the exact RIJO package archive.
- A clean `npm ci` can restore the project-local RIJO version.
- Native protocol v2 rejects stale task identity and revoked leases.
- File state recovery works without SQLite.
- The canonical skill and templates pass the controlled English tests.

## Open gates

- The final Codex native workflow did not reach milestone closeout.
  Its old fixture used a machine-local package resolution.
  The engineering review blocked the phase after two bounded repair cycles.
  The current installer fixes this defect for new fixtures.
- The Claude Code native workflow did not run in this Codex session.
  RIJO did not start a nested Claude process.
- The required stuck-subagent E2E did not run against both native hosts on the
  final commit.

## Decision

Do not declare `RIJO_NATIVE_READY`.
Do not promote this release candidate to `0.2.0`.
Run new Codex and Claude Code native fixtures from the packed final commit.
Promote the release only after both fixtures pass `new`, `start`, `test`, and
`finish`.

See
[`artifacts/certification/native-macos/REPORT.md`](../artifacts/certification/native-macos/REPORT.md)
for command evidence and limitations.
