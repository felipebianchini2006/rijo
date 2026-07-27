# Fix a defect

Run these stages in order:

`REPRODUCE → ROOT_CAUSE → MINIMAL_FIX → REGRESSION_TEST → VERIFY → DOCUMENT`

1. Reproduce the reported defect.
2. Record objective reproduction evidence.
3. Identify the root cause.
4. Add a failing regression test when the behavior is testable.
5. Apply the smallest safe fix.
6. Run the regression test.
7. Run affected verification commands.
8. Document the fix in `.rijo/fixes/`.

Create a new phase only for an architectural, destructive, security-wide, or business-intent change.
