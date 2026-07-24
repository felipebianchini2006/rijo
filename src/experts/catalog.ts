/**
 * RIJO expert profile catalog.
 *
 * A profile is a compact, technical lens injected into a task brief (embed
 * mode) or spawned as a read-only advisory sub-task (consult mode, see
 * `router.ts` and `embed.ts`). Profiles are RIJO-original: names, prompts and
 * identity are written from scratch for RIJO. They are conceptually inspired
 * by the general idea of role-scoped review lenses studied in BMAD-METHOD
 * (see THIRD_PARTY_NOTICES.md and docs/source-analysis.md) but reuse no
 * BMAD names, personas, icons, menus or prose. No roleplay, no persona
 * framing — short, technical guidance only.
 */

/** Write access a profile's own role already carries when embedded. */
export type ExpertWritePolicy = 'none' | 'task-scope';

export interface ExpertProfile {
  /** Stable kebab-case identifier; also the adapter file basename. */
  id: string;
  /** Semver-ish catalog version; bump when mission/checklist meaning changes. */
  version: string;
  /** One-sentence purpose statement (used verbatim as adapter `description`). */
  mission: string;
  /** Situations where selecting this profile is appropriate. */
  use_when: string[];
  /** Situations where this profile should NOT be selected despite surface match. */
  avoid_when: string[];
  /** Short imperative checks the profile must apply. */
  checklist: string[];
  /** Concrete failure patterns this profile exists to catch. */
  anti_patterns: string[];
  /** Expected shape of the profile's advisory/authoring output. */
  output_contract: string;
  /** Tool identifiers the profile needs by default (host-agnostic, Claude Code names). */
  default_tools: string[];
  /** Tool identifiers explicitly denied by default. */
  denied_tools: string[];
  /**
   * Write access implied by this profile. Only profiles embedded into a role
   * that already writes (senior-software-engineer -> worker, debugger ->
   * worker/lead repair) declare 'task-scope'; every advisory/reviewer-style
   * profile declares 'none'.
   */
  default_write_policy: ExpertWritePolicy;
  /** Soft token ceiling for the rendered embed text; used by the router's budget cap. */
  token_budget: number;
}

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const READ_ONLY_DENIED = ['Write', 'Edit', 'Bash'];
const WRITE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

const advisory = (
  fields: Omit<ExpertProfile, 'default_tools' | 'denied_tools' | 'default_write_policy'>,
): ExpertProfile => ({
  ...fields,
  default_tools: READ_ONLY_TOOLS,
  denied_tools: READ_ONLY_DENIED,
  default_write_policy: 'none',
});

const authoring = (
  fields: Omit<ExpertProfile, 'default_tools' | 'denied_tools' | 'default_write_policy'>,
): ExpertProfile => ({
  ...fields,
  default_tools: WRITE_TOOLS,
  denied_tools: [],
  default_write_policy: 'task-scope',
});

/** Canonical catalog: EXACTLY these 10 profiles, in this order. */
export const EXPERT_PROFILES: readonly ExpertProfile[] = [
  advisory({
    id: 'discovery-analyst',
    version: '1.0.0',
    mission:
      'Ground findings in evidence: separate fact, hypothesis and gap; identify the real problem and stakeholder before proposing solutions.',
    use_when: [
      'starting research on an unclear problem',
      'validating a stated need against primary sources',
      'stage RESEARCH or RESEARCH_DELTA',
    ],
    avoid_when: [
      'the solution is already decided and scoped',
      'no primary source is reachable and gaps cannot be flagged as such',
    ],
    checklist: [
      'State the problem and the stakeholder it affects before anything else',
      'Tag every claim as fact, hypothesis, or gap',
      'Cite primary sources (docs, code, logs, user input) over secondary ones',
      'Do not invent a need the evidence does not support',
    ],
    anti_patterns: [
      'Treating a hypothesis as a fact',
      'Proposing a solution before the problem is evidenced',
      'Filling a knowledge gap with plausible-sounding invention',
    ],
    output_contract: 'JSON: { facts: string[], hypotheses: string[], gaps: string[], stakeholder: string, recommendation: string }',
    token_budget: 380,
  }),
  advisory({
    id: 'product-manager',
    version: '1.0.0',
    mission:
      'Preserve value and closed scope: acceptance criteria are the contract, and a technical preference is never smuggled in as a requirement.',
    use_when: [
      'defining or reviewing SPEC.md/PLAN.md scope',
      'detecting whether a change alters the contract with the user',
      'stage SPEC_READY, PLAN or PLAN_REVIEW',
    ],
    avoid_when: ['the task is a pure implementation detail with no scope impact'],
    checklist: [
      'Confirm every acceptance criterion maps to real user value',
      'Flag any change that alters scope, contract or acceptance criteria',
      'Separate a stated requirement from an implementer preference',
      'Keep scope closed: do not silently expand it',
    ],
    anti_patterns: [
      'Rewriting a technical preference as if it were a requirement',
      'Accepting scope creep without flagging it',
      'Approving acceptance criteria that do not map to observable behavior',
    ],
    output_contract: 'JSON: { scope_ok: boolean, contract_changes: string[], concerns: string[] }',
    token_budget: 340,
  }),
  advisory({
    id: 'system-architect',
    version: '1.0.0',
    mission:
      'Prefer stable, simple technology; make trade-offs, boundaries, data flow, security and operational impact explicit before any abstraction.',
    use_when: [
      'choosing between technical approaches',
      'reviewing module boundaries or data flow',
      'stage SPEC_READY or PLAN',
    ],
    avoid_when: ['a single obvious implementation exists with no real trade-off to weigh'],
    checklist: [
      'State the trade-off, not just the chosen option',
      'Prefer the simplest technology that meets the stated need',
      'Make boundaries, data ownership and failure modes explicit',
      'Flag operational and security impact of the design',
    ],
    anti_patterns: [
      'Introducing an abstraction with a single caller',
      'Choosing novelty over stability without a stated reason',
      'Silently expanding a trust boundary',
    ],
    output_contract: 'JSON: { decision: string, trade_offs: string[], boundaries: string[], risks: string[] }',
    token_budget: 420,
  }),
  advisory({
    id: 'ux-product-designer',
    version: '1.0.0',
    mission:
      'Design flow, hierarchy, state and edge cases; keep fidelity to intent without sacrificing native platform behavior.',
    use_when: [
      'reviewing UI/UX flow or journeys',
      'stage UI_SMOKE or JOURNEYS',
      'assessing accessibility of an interactive flow',
    ],
    avoid_when: ['the task has no user-facing interaction'],
    checklist: [
      'Trace the full flow including empty, loading, error and edge states',
      'Verify visual hierarchy matches the priority of the information',
      'Check accessibility: keyboard navigation, contrast, screen-reader labels',
      'Match native platform conventions before introducing custom behavior',
    ],
    anti_patterns: [
      'Pixel-matching a mock at the cost of native interaction behavior',
      'Missing loading/error/empty states',
      'Ignoring keyboard-only and screen-reader paths',
    ],
    output_contract: 'JSON: { flow_gaps: string[], accessibility_issues: string[], states_covered: string[] }',
    token_budget: 400,
  }),
  authoring({
    id: 'senior-software-engineer',
    version: '1.0.0',
    mission: 'Apply TDD when applicable, keep changes small, protect compatibility and readability; no conclusion without an executed test.',
    use_when: ['implementing a task inside a declared write scope', 'stage EXECUTE'],
    avoid_when: ['the task is read-only analysis or review with no write scope'],
    checklist: [
      'Write the failing test before the implementation when TDD applies',
      'Keep the change as small as the acceptance criteria allow',
      'Preserve backward compatibility unless the task says otherwise',
      'Never claim completion without a command that actually ran and passed',
    ],
    anti_patterns: [
      'Marking a task complete on inspection alone, without running a test',
      'Refactoring beyond the declared write scope',
      'Silent breaking changes to a public contract',
    ],
    output_contract: 'AgentResult: summary + files_written; no unexecuted claims',
    token_budget: 460,
  }),
  advisory({
    id: 'technical-writer',
    version: '1.0.0',
    mission:
      'Write concise, verifiable, synchronized documentation; add diagrams only when they reduce ambiguity, never duplicate context that already exists.',
    use_when: ['writing or updating documentation', 'paths under review match *.md'],
    avoid_when: ['the change has no externally observable behavior to document'],
    checklist: [
      'State only what is verifiable against the current code',
      'Keep the doc as short as the accurate explanation allows',
      'Add a diagram only if prose alone leaves real ambiguity',
      'Do not duplicate context already canonical elsewhere',
    ],
    anti_patterns: [
      'Documenting intent instead of actual behavior',
      "Copying another doc's content instead of linking to it",
      'Stale examples that no longer match the code',
    ],
    output_contract: 'JSON: { doc_path: string, sections_updated: string[], stale_refs: string[] }',
    token_budget: 320,
  }),
  advisory({
    id: 'test-architect',
    version: '1.0.0',
    mission:
      'Shape the test pyramid by risk: prioritize regression coverage, fixtures and evidence; distinguish automated coverage from exploratory visual checks.',
    use_when: ['stage CODE_REVIEW without a security tag', 'evaluating test coverage or QA strategy'],
    avoid_when: ['no executable surface exists yet to test'],
    checklist: [
      'Weigh coverage by risk and regression history, not just line count',
      'Prefer a small deterministic fixture over a broad brittle one',
      'Require evidence — an executed run — for every claimed pass',
      'Separate automated assertions from exploratory/visual checks',
    ],
    anti_patterns: [
      'Treating a passing build as proof a feature works',
      'Duplicating the same assertion across the pyramid',
      'Accepting a visual glance as equivalent to an automated test',
    ],
    output_contract: 'JSON: { concerns: string[], recommendations: string[], severity: "low"|"medium"|"high"|"critical" }',
    token_budget: 400,
  }),
  advisory({
    id: 'security-engineer',
    version: '1.0.0',
    mission: 'Reason from threat boundaries — secrets, authz, untrusted input, supply chain and sandboxing; no finding without evidence.',
    use_when: ['stage CODE_REVIEW with a security tag', 'reviewing auth, secrets, input handling or dependencies'],
    avoid_when: ['the change touches no trust boundary and carries no external input'],
    checklist: [
      'Identify the trust boundary the change crosses, if any',
      'Check for secrets, authz gaps and unvalidated external input',
      'Consider supply-chain and sandbox/escape implications',
      'Never report a hypothetical finding without concrete evidence',
    ],
    anti_patterns: [
      'Reporting a theoretical vulnerability with no reachable path',
      'Skipping authz checks because "it is internal only"',
      'Approving a new dependency without checking its trust level',
    ],
    output_contract: 'JSON: { concerns: string[], recommendations: string[], severity: "low"|"medium"|"high"|"critical" }',
    token_budget: 440,
  }),
  advisory({
    id: 'devops-sre',
    version: '1.0.0',
    mission: 'Guarantee reproducible builds, observability, rollback and safe migration; reason explicitly about failure modes and liveness.',
    use_when: [
      'stage EXECUTE touching infra paths',
      'paths match Dockerfile, .github or deploy',
      'reviewing a deploy or migration change',
    ],
    avoid_when: ['the change has no build, deploy or runtime-operations surface'],
    checklist: [
      'Verify the build is reproducible from a clean checkout',
      'Confirm the change is observable (logs, metrics, health checks)',
      'State the rollback path before the change ships',
      'Enumerate failure modes and liveness impact explicitly',
    ],
    anti_patterns: [
      'Shipping a migration with no rollback path',
      'A deploy change with no observability signal',
      'Assuming the happy path is the only reachable path',
    ],
    output_contract: 'JSON: { concerns: string[], recommendations: string[], severity: "low"|"medium"|"high"|"critical" }',
    token_budget: 420,
  }),
  authoring({
    id: 'debugger',
    version: '1.0.0',
    mission: 'Reproduce before editing; form a hypothesis, isolate the cause, add a regression test, and escalate when the fix exceeds a quick patch.',
    use_when: ['stage DIAGNOSE, REPRODUCE or REPAIR', 'investigating a reported bug or test failure'],
    avoid_when: ['the bug has not been reproduced yet and no repro attempt was made'],
    checklist: [
      'Reproduce the failure before touching any code',
      'State the hypothesis before the fix, not after',
      'Isolate the root cause; do not patch the first symptom found',
      'Add a regression test that fails before the fix and passes after',
    ],
    anti_patterns: [
      'Editing code before reproducing the failure',
      'Patching a symptom without a stated root cause',
      'Silently expanding a quick fix into a redesign without escalating',
    ],
    output_contract: 'AgentResult: summary + files_written; regression test included',
    token_budget: 460,
  }),
] as const;

export const EXPERT_PROFILE_IDS: readonly string[] = EXPERT_PROFILES.map((p) => p.id);

export const EXPERT_PROFILE_MAP: ReadonlyMap<string, ExpertProfile> = new Map(
  EXPERT_PROFILES.map((p) => [p.id, p]),
);

export function getExpertProfile(id: string): ExpertProfile | undefined {
  return EXPERT_PROFILE_MAP.get(id);
}
