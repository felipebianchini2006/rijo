# RIJO native macOS certification

## Environment

- Date: 2026-07-28
- Platform: macOS 26.5.2
- Build: 25F84
- Architecture: arm64
- Node.js: 22.23.1 and 24.18.0
- npm: 11.16.0
- RIJO: 0.2.0-rc.1
- Tested implementation commit: `47da8d1d3c7ec546aafc6da91defaf9be01e9fe0`

## Deterministic matrix

The following commands passed on the source commit:

```text
mise exec node@24.18.0 -- npm ci
mise exec node@24.18.0 -- npm run typecheck
mise exec node@24.18.0 -- npm test
mise exec node@24.18.0 -- npm run build
mise exec node@24.18.0 -- npm audit --omit=dev --audit-level=high

mise exec node@22.23.1 -- npm ci
mise exec node@22.23.1 -- npm run typecheck
mise exec node@22.23.1 -- npm test
mise exec node@22.23.1 -- npm run build
```

The full suite includes the security, map, supervisor, ZIP, workspace,
installer, file-store recovery, native protocol, native workflow, browser, and
package installation tests.

## Codex native workflow

The active Codex session used native subagents.
It did not start `codex exec`.
It completed project research, roadmap creation, phase research, phase
planning, independent plan review, bounded implementation, real verification,
and independent engineering review.

The engineering reviewer rejected the old fixture for these reasons:

- The fixture lockfile used a machine-local RIJO path.
- The fixture did not contain explicit Node.js 22 and Node.js 24 run evidence.
- The browser and server used different Unicode length definitions.

The deterministic core stopped after two review cycles.
It did not claim phase completion.
This is correct bounded-loop behavior.

The source installer now vendors the exact package archive and uses a portable
project-relative file specification.
The installer regression test restores the package with a clean `npm ci`.

## Claude Code native workflow

This Codex session did not start Claude Code.
No nested `claude -p` process ran.
The final Claude Code native E2E has no evidence for this commit.

## Package

- File: `rijo-0.2.0-rc.1.tgz`
- npm shasum: `0eadeea1045af3c35633ce752cd4bf53dff052ca`
- SHA-256: `0f53ee29b301003ee75247f74b94a18cd1c2f4dc26647bd63fe131a1f67f6881`
- Size: 431.6 kB
- Files: 290

The packed package installed in a clean fixture.
The installed package command `rijo install --codex --project` created the
project launcher.
A subsequent clean `npm ci` passed.
The launcher returned `0.2.0-rc.1`.
The lockfile resolved RIJO from
`file:.rijo/tooling/rijo-0.2.0-rc.1.tgz`.

## Verdict

`NOT_READY`

Do not declare `RIJO_NATIVE_READY`.
Do not promote the package to `0.2.0`.
Run clean final native fixtures in Codex and Claude Code before promotion.
