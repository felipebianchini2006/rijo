# Models, roles, and cost

The RIJO core does not select a provider model. The active host resolves each
native subagent role to an available model.

Secondary automation adapters can use the free-form tiers in
`.rijo/config.yml`. The adapter resolves each tier to a concrete provider
model.

## Roles

| Role | Responsibility | Default tier | Cost profile |
|---|---|---|---|
| `lead` | Thin orchestration and defect diagnosis | `strongest` | Few calls with small context |
| `reviewer` | Independent plan, code, and visual review | `strongest-independent` | One or two calls per phase |
| `planner` | Phase research and planning | `balanced-reasoning` | One to three calls per phase |
| `worker` | One implementation task with a strict write scope | `economical-coding` | Two to four calls per phase |
| `researcher` | Focused research from primary sources | `economical-research` | Up to four parallel calls |
| `qa` | Browser or simulator journeys | `economical-browser` | One call per journey |

The reviewer receives the plan, diff, and evidence. The reviewer does
not receive the author reasoning.

## Secondary adapter configuration

This example uses stronger models for coordination and economical models for
bounded work:

```yaml
models:
  lead: strongest
  reviewer: strongest-independent
  planner: balanced-reasoning
  worker: economical-coding
  researcher: economical-research
  qa: economical-browser
limits:
  plan_revisions: 2
  review_loops: 2
  qa_fix_loops: 2
  fix_attempts: 2
  max_parallel_agents: 4
```

You can change tier mappings without a core change. A host without parallel
subagents runs roles in sequence. RIJO records the real host capability.

## Token use

Agent work uses tokens for these operations:

- Project and phase research.
- Phase plans.
- Implementation tasks.
- Independent reviews.
- Product Quality Assurance journeys.

The deterministic core does not use model tokens for these operations:

- Schema validation.
- Plan lint.
- Requirement and test traceability.
- Locks and atomic writes.
- State transitions.
- Drift detection.
- Status rendering.
- Checkpoint recovery.

RIJO gives each subagent a bounded brief. The brief contains the objective,
required files, write scope, acceptance criteria, verification commands, and
output contract. RIJO does not send the full repository by default.
