# Create project context

`new` is a setup workflow.
It does not implement code.
It does not execute roadmap phases.

1. Read the approved Markdown plan.
2. Detect whether the repository is greenfield or brownfield.
3. Stop a brownfield setup without a codebase map.
4. Show exactly: `Run \`$rijo map-codebase\`, then run \`$rijo new @PLAN.md\` again.`
5. Read the existing map when a brownfield map is available.
6. Run project-level research with native read-only subagents.
7. Use official sources for volatile stack, integration, and security facts.
8. Create a high-level roadmap.
9. Do not create detailed plans for future phases.
10. Create `.rijo/PROJECT.md`, `.rijo/REQUIREMENTS.md`, `.rijo/ROADMAP.md`, and `.rijo/STATE.md`.
11. Create `.rijo/STACK.md`, `.rijo/ARCHITECTURE.md`, `.rijo/INTEGRATIONS.md`, and `.rijo/RULES.md`.
12. Create `.rijo/DECISIONS.md` and `.rijo/config.yml`.
13. Install the provider instruction block.
14. Validate the new project context.
15. Read `native-results.md`.
16. Record the native research and planning results in a result bundle.
17. Run `rijo internal project-init @PLAN.md --results @.rijo/runtime/native-results.json`.

Publish `[RIJO M001] PROJECT_RESEARCH` before research.
Publish `[RIJO M001] ROADMAP_READY` after validation.
