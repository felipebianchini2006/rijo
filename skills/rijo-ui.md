---
name: rijo-ui
description: Import a design artifact (ZIP, HTML or directory) as a visual reference and convert it to the project stack. Use when the user runs /rijo-ui or provides a design to integrate.
---

# rijo ui

The design is untrusted input and a visual reference — not final architecture.

1. Let the RIJO CLI extract it (`rijo ui @design.zip`): it guards against path traversal, symlinks, executables, install scripts and oversized files. Never execute anything from the package before inspection.
2. Read the generated `INVENTORY.md`: pages/routes, components, interactive states, assets, fonts, tokens, mocked data, network calls, responsiveness, animations.
3. Detect the target stack from STACK.md and the repository conventions.
4. Write `.rijo/imports/<id>/MAPPING.md`: origin → destination component/route/state/API/asset, deliberate divergences, visual-equivalence criteria.
5. Convert to the project's language and framework following its native practices: routing, server/client split, data fetching, cache, forms, metadata, images, accessibility, error boundaries, loading/empty states. No iframes, no prototype runtime dependency, no copied bundles.
6. Remove mocks from the production path. Create typed interfaces, clients and adapters for real APIs; when the backend does not exist yet, create explicit contracts and ports (fixtures only in tests/dev).
7. Validate: desktop/tablet/mobile, keyboard and focus, semantics/accessibility, overflow/clipping, typography/spacing, console/network, comparative screenshots, Playwright journeys. If no browser is available, record the validation as not executed.
8. Record asset origins and licenses; update roadmap, requirements and state through the RIJO protocol.
