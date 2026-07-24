import type { ModelRole, RijoConfig, Stage } from '../core/schemas/index.js';
import type { AgentTaskDraft } from '../agents/protocol.js';
import { tierFor } from '../agents/roles.js';
import { routeProfiles, validateProfiles } from '../experts/router.js';

/**
 * Explicit context the deterministic expert router needs to pick the lenses
 * for a task. Everything here is derived by the workflow at the dispatch site
 * (stage, tags, write/read paths, risk) — never guessed by a model.
 */
export interface DispatchRouting {
  stage?: Stage;
  requirementTags?: string[];
  /** write_scope + code_files signal; defaults to the draft's own paths. */
  paths?: string[];
  highRisk?: boolean;
  /** For reviewer routing: the author's lenses, which a reviewer must not inherit. */
  authorProfiles?: string[];
  /** Informational label for the work being routed (diagnostics only). */
  workType?: string;
}

/** Path fragments that mark security-sensitive work (adds a security lens). */
const SECURITY_PATH = /(^|\/)(security|auth|authn|authz|crypto|password|secret|token|session)([./_-]|$)/i;
/** Path fragments that mark high-risk surfaces (architecture/infra/migrations). */
const HIGH_RISK_PATH = /(^|\/)(migrations?|infra|deploy|Dockerfile|\.github\/|payment|billing)([./_-]|$)/i;

/** Infer a security tag from write/read paths so a security lens is auto-attached. */
export function inferSecurityTag(paths: string[]): string[] {
  return paths.some((p) => SECURITY_PATH.test(p)) ? ['security'] : [];
}

/** Infer high-risk from paths (architecture/security/infra) for consult-mode selection. */
export function inferHighRisk(paths: string[]): boolean {
  return paths.some((p) => SECURITY_PATH.test(p) || HIGH_RISK_PATH.test(p));
}

/**
 * Canonical routing gate: EVERY dispatched task passes through here before it
 * reaches the executor. It resolves the model tier from config, runs the
 * deterministic expert router with an explicit context, and stamps the
 * validated `expert_profiles` onto the draft (max 3; researcher gets exactly
 * one discovery lens; a reviewer never inherits the author's primary lens).
 * consult-mode is reserved for high-risk work (architecture/security/critical
 * UX or test surfaces); embed is the default and is what the rendered brief
 * consumes via `## Expert guidance`.
 */
export function prepareDispatchedTask(
  config: RijoConfig,
  draft: AgentTaskDraft,
  routing: DispatchRouting = {},
): AgentTaskDraft {
  const role: ModelRole = draft.role;
  const tier = draft.tier ?? tierFor(config, role);
  const paths = routing.paths ?? [...(draft.write_scope ?? []), ...(draft.code_files ?? [])];
  const route = routeProfiles({
    role,
    ...(routing.stage ? { stage: routing.stage } : {}),
    requirement_tags: routing.requirementTags ?? [],
    paths,
    high_risk: routing.highRisk ?? false,
  });

  let profiles = [route.primary, ...route.complementary];
  // A reviewer's lens must be independent of the author's: strip any overlap
  // with the author's profiles, never leaving the set empty.
  if (role === 'reviewer' && routing.authorProfiles && routing.authorProfiles.length > 0) {
    const filtered = profiles.filter((p) => !routing.authorProfiles!.includes(p));
    profiles = filtered.length > 0 ? filtered : [route.primary];
  }
  profiles = profiles.slice(0, 3);
  validateProfiles(profiles);

  return { ...draft, tier, expert_profiles: profiles };
}
