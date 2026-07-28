# Create project context

`new` is a setup workflow.
It does not implement code.
It does not execute roadmap phases.

1. Read the approved Markdown plan.
2. Detect whether the repository is greenfield or brownfield.
3. Stop a brownfield setup without a codebase map.
4. Show exactly: `Run \`$rijo map-codebase\`, then run \`$rijo new @PLAN.md\` again.`
5. Read the existing map when a brownfield map is available.
6. Run three project research lanes in parallel.
7. Assign stable stack versions and official practices to the first lane.
8. Assign architecture, integrations, and system limits to the second lane.
9. Assign gaps, pitfalls, data risks, and security surfaces to the third lane.
10. Use read-only native subagents for each lane.
11. Use official sources for volatile facts.
12. Use one independent roadmapper.
13. Create three to six natural phases for a typical project.
14. Use fewer phases for a smaller scope.
15. Do not create phases only to reach a number.
16. Do not create separate security, test, cleanup, audit, or refactor phases.
17. Do not create detailed plans for future phases.
18. Create `.rijo/PROJECT.md`, `.rijo/REQUIREMENTS.md`, `.rijo/ROADMAP.md`, and `.rijo/STATE.md`.
19. Create `.rijo/STACK.md`, `.rijo/ARCHITECTURE.md`, `.rijo/INTEGRATIONS.md`, and `.rijo/RULES.md`.
20. Create `.rijo/DECISIONS.md` and `.rijo/config.yml`.
21. Save the research synthesis in the active milestone `RESEARCH.md`.
22. Materialize approved decisions in the global context files.
23. Install the provider instruction block.
24. Validate the new project context.
25. Read `native-results.md`.
26. Record the native research and planning results in a result bundle.
27. Run `node .rijo/bin/rijo.cjs internal project-init @PLAN.md --results @.rijo/runtime/native-results.json`.

Publish `[RIJO M001] SCOPE_PARSE` before scope extraction.
Publish `[RIJO M001] PROJECT_RESEARCH` before research.
Publish `[RIJO M001] ROADMAP_READY` after validation.
