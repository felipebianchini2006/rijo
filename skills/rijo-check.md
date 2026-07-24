---
name: rijo-check
description: Test everything and produce a production-readiness decision (READY/NOT_READY/BLOCKED). Use when the user runs /rijo-check or asks whether the project is ready for production. Never deploys.
---

# rijo check

Produce `.rijo/milestones/<active>/qa/production-readiness.md`. This flow never deploys.

1. Pin the evaluated commit and environment.
2. Run every deterministic check that exists in the project: format, lint, typecheck, production build, unit/integration/contract/E2E tests, migrations, dependency audit, secret scan, static security, automated accessibility. Record command + exit code.
3. Derive personas and journeys from the requirements — never from random exploration. Map journeys to requirement IDs.
4. Spawn isolated browser subagents per journey (max 4 parallel). Each one: logs in as a real user, executes the full flow, clicks the relevant actions, verifies persistence and side effects, watches console/network/4xx/5xx/exceptions, checks loading/empty/success/error states, tests permissions and keyboard navigation, captures screenshots/traces on failure, records reproducible steps. Cover desktop/tablet/mobile on priority visual flows.
5. Run an independent visual reviewer: misalignment, overflow, clipping, contrast, density, hierarchy, typography, component inconsistency, interaction feedback, responsiveness. Semantic judgment, not pixel diffing.
6. With `--fix`: group failures by root cause, fix in limited scope, re-run only failing journeys and needed regressions. Two rounds maximum.
7. READY only when: production build passes, 100% of first-version requirements are mapped, critical journeys pass, no valid blocker/critical/high finding, no unhandled console/network error in critical flows, migrations and configuration documented, no mandatory check silently skipped.
8. If a browser, environment, credential or indispensable service is unavailable: status is BLOCKED. Never READY by inference.

## Turnkey host mode

To run this flow autonomously against your own CLI, invoke the turnkey command instead of hand-rolling a protocol loop: `rijo check --host claude` (or `--host codex`, or set `config.host.provider`). RIJO detects the host (a missing CLI BLOCKS), supervises every attempt and prints progress to stderr. `npx rijo serve --stdio` remains available as the advanced JSON-RPC API for external hosts.
