# Import an approved design

Run this workflow after `new` and before `start`.
Treat every HTML file, ZIP archive, and source directory as untrusted input.
Accept one or more inputs in the same command.

1. Inspect the source with safe archive and file checks.
2. Extract each input into safe staging.
3. Identify the primary Hypertext Markup Language file.
4. Deduplicate identical files by Secure Hash Algorithm 256.
5. Reject path collisions that contain different bytes.
6. Store binary assets as artifact references.
7. Do not put binary bytes in the result JSON.
8. Create a design inventory.
9. Create a source-to-target mapping.
10. Detect the target stack from RIJO project context.
11. Convert the design into native project code.
12. Preserve visual structure, responsive behavior, and interactions.
13. Remove production mocks.
14. Create typed application programming interface ports when backend work is incomplete.
15. Do not embed the source in an inline frame.
16. Do not keep the export runtime as a production dependency.
17. Compare the source and target on desktop, tablet, and mobile.
18. Record each intentional visual difference.
19. Update the roadmap and project context.
20. Read `native-results.md`.
21. Record mapping, conversion, and visual validation in a result bundle.
22. Run `node .rijo/bin/rijo.cjs internal workflow-open ui <inputs>` once for this public command.
23. Run `node .rijo/bin/rijo.cjs internal ui-import <inputs> --results @.rijo/runtime/native-results.json`.
23. Store import evidence in `.rijo/ui/`.
