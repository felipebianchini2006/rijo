# Test the product

Run this workflow after implementation is complete.
Derive each journey from requirement identifiers.

1. Create `.rijo/qa/JOURNEYS.md`.
2. Start the application with the approved deterministic command policy.
3. Use the available browser for a web product.
4. Use the available simulator or emulator for a mobile product.
5. Create required test users.
6. Run each critical journey with real controls.
7. Check persistence and authorization.
8. Check console and network errors.
9. Check loading, empty, success, and error states.
10. Check desktop, tablet, and mobile layouts for web products.
11. Capture screenshots, traces, and logs for defects.
12. Use bounded repair and rerun loops.
13. Write `.rijo/qa/FINDINGS.md`, `.rijo/qa/TEST-REPORT.md`, and `.rijo/qa/READINESS.md`.
14. Read `native-results.md`.
15. Record the native Quality Assurance results in a result bundle.
16. Run `rijo internal qa-record --results @.rijo/runtime/native-results.json`.

Return only `READY`, `NOT_READY`, or `BLOCKED`.
Return `BLOCKED` when a required browser, simulator, or emulator is unavailable.
Do not deploy.
