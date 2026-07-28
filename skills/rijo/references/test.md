# Test the product

Run this workflow after implementation is complete.
Derive each journey from requirement identifiers.

1. Run `node .rijo/bin/rijo.cjs internal qa-open`.
2. Create `.rijo/qa/JOURNEYS.md`.
3. Start the application with the approved deterministic command policy.
4. Use the available browser for a web product.
5. Use the available simulator or emulator for a mobile product.
6. Create required test users.
7. Run each critical journey with real controls.
8. Check persistence and authorization.
9. Check console and network errors.
10. Check loading, empty, success, and error states.
11. Check desktop, tablet, and mobile layouts for web products.
12. Capture screenshots, traces, and logs for defects.
13. Use bounded repair and rerun loops.
14. Write `.rijo/qa/FINDINGS.md`, `.rijo/qa/TEST-REPORT.md`, and `.rijo/qa/READINESS.md`.
15. Read `native-results.md`.
16. Record the native Quality Assurance results in a result bundle.
17. Run `node .rijo/bin/rijo.cjs internal qa-record --results @.rijo/runtime/native-results.json`.

Return only `READY`, `NOT_READY`, or `BLOCKED`.
Return `BLOCKED` when a required browser, simulator, or emulator is unavailable.
Return `READY` only after RIJO records the tested QA checkpoint.
Do not deploy.
