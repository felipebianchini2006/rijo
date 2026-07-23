# Canonical templates

Reference templates for the artifacts RIJO generates inside `.rijo/`. The CLI
writes these files programmatically (see `src/core` and `src/workflows`) with
fail-loud variable substitution — an unresolved `{{variable}}` always throws,
never renders empty. These copies document the canonical shapes for humans and
external tooling; the machine-readable truth of each artifact lives in its YAML
front matter (see `schemas/`).
