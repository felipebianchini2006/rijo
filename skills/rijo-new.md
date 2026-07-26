---
name: rijo-new
description: Convert a closed-scope development plan into RIJO context, research, requirements and an executable roadmap. Use when the user runs /rijo-new or asks to initialize RIJO with a plan file, or to start the next milestone with --next.
---

# rijo new

You are the RIJO orchestrator (lead role). Stay thin: coordinate state and decisions; delegate work to fresh-context subagents.

## Procedure

1. Run `rijo --status --json` to see the current state. If a RIJO project already exists and the user did not pass `--next`, refuse non-destructively and show the exact `rijo new @PLAN.md --next` command.
2. Read the plan file the user referenced (`@PLANO.md`). On a brownfield repository, `rijo new` guarantees a fresh `.rijo/codebase/` map under the same lock (full when missing, no-op when fresh, incremental when stale) before planning.
3. Fill the planner role yourself or via a subagent: extract scope, out-of-scope, functional and non-functional requirements (each with an acceptance scenario), integrations, risks, dependencies, premises. Use the directed codebase context packet and cite real mapped modules, paths, contracts and symbols. Map each requirement to exactly one vertical-slice phase (2+ phases only when the scope demands it). Classify items as NEW/CHANGE/REMOVE/CARRYOVER/UNCHANGED_DEPENDENCY when this is a new milestone.
4. Resolve reversible technical gaps autonomously according to the structured decision policy. Never generate a menu of choices. Record only material decisions with evidence in `.rijo/DECISIONS.md`. Only stop for a permitted factual blocker, with one objective question.
5. On the first milestone, spawn up to 4 parallel researcher subagents (stack+versions, architecture+patterns, features/UX/integrations, risks/security/pitfalls). Each must cite official sources with claim, url, check date, version. On later milestones, reuse `.rijo/research/cache.json` and research only the delta.
6. Persist all artifacts through the RIJO protocol (the CLI writes atomically): SCOPE.md, REQUIREMENTS.md, ROADMAP.md, RESEARCH.md, plus the global PROJECT.md, RULES.md, STACK.md, STATE.md.
7. Publish short transition markers in chat at each stage change: `[RIJO M001] ANALYZE …`, `[RIJO M001] RESEARCH …`, `[RIJO M001] ROADMAP …`.
8. If `--run` was requested, continue directly into the rijo-run skill with target `all` (the same `--host` binding, if any, carries through: `rijo new @PLANO.md --host claude --run`).

## Rules

- Never overwrite or renumber a historic milestone.
- Unknown local changes are never discarded or stashed; block with a precise diagnostic.
- The automatically loaded context must stay under 24 KB.

## Turnkey host mode (preferred)

To run `new` autonomously against your own CLI, do NOT hand-roll a protocol loop. Invoke the turnkey command and let RIJO detect the host and supervise every attempt:

```
rijo new @PLANO.md --host claude          # or: --host codex
rijo new @PLANO.md --host claude --run     # create the milestone, then run all phases
```

RIJO resolves the host from `--host` (or `config.host.provider`), detects the CLI (a missing binary BLOCKS — nothing is simulated) and drives each supervised research/planning subagent. Progress prints to stderr; the outcome and exit code are coherent with the other commands.

## Host bridge (advanced API for external hosts)

An external host that embeds RIJO directly can instead spawn `npx rijo serve --stdio` and speak JSON-RPC over stdio: send `{"type":"request","method":"workflow.new","id":1,"params":{"planFile":"@PLANO.md"}}`. Answer each `{"type":"request","method":"agent.runTask",...}` by executing the described subagent and replying `{"type":"response","id":<same>,"result":{...AgentResult...}}`. Prefer the turnkey command above unless you are building such a host.
