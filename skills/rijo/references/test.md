# Test the product

Run this workflow after implementation is complete.
Derive each journey from requirement identifiers.
Repair defects by default.

1. Run `node .rijo/bin/rijo.cjs internal qa-open`.
2. Create `.rijo/qa/JOURNEYS.md`.
3. Start the application with the approved deterministic command policy.
4. Use the available browser for a web product.
5. Use the available simulator or emulator for a mobile product.
6. Create required test users.
7. Run every requirement-derived journey with real controls.
8. Check persistence and authorization.
9. Check console and network errors.
10. Check loading, empty, success, and error states.
11. Check desktop, tablet, and mobile layouts for web products.
12. Capture screenshots, traces, and logs for defects.
13. Record each defect before repair.
14. Allow two repair attempts for each defect.
15. Continue other journeys when one journey fails.
16. Repeat each affected journey after a repair.
17. Run one complete regression pass after any repair.
18. Run at most three complete regression passes.
19. Store per-journey evidence in `.rijo/qa/test-results/`.
20. Write `.rijo/qa/FINDINGS.md`, `.rijo/qa/TEST-REPORT.md`, and `.rijo/qa/READINESS.md`.
21. Read `native-results.md`.
22. Record the native Quality Assurance results in a result bundle.
23. Run `node .rijo/bin/rijo.cjs internal qa-record --results @.rijo/runtime/native-results.json`.

Return only `READY`, `NOT_READY`, or `BLOCKED`.
Return `BLOCKED` when a required browser, simulator, or emulator is unavailable.
Return `NOT_READY` when a defect remains after its repair budget.
Return `READY` only after RIJO records the tested QA checkpoint.
Do not deploy.
