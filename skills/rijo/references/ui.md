# Import an approved design

Run this workflow after `new` and before `start`.
Treat every HTML file, ZIP archive, and source directory as untrusted input.

1. Inspect the source with safe archive and file checks.
2. Create a design inventory.
3. Create a source-to-target mapping.
4. Detect the target stack from RIJO project context.
5. Convert the design into native project code.
6. Preserve visual structure, responsive behavior, and interactions.
7. Remove production mocks.
8. Create typed application programming interface ports when backend work is incomplete.
9. Do not embed the source in an inline frame.
10. Do not keep the export runtime as a production dependency.
11. Verify rendering and responsiveness.
12. Update the roadmap and project context.
13. Store import evidence in `.rijo/ui/`.
