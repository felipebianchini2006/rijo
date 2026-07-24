import type { ModelRole, Stage } from '../core/schemas/index.js';
import { EXPERT_PROFILE_IDS, EXPERT_PROFILE_MAP } from './catalog.js';

/** Raised when a caller references an expert profile id absent from the catalog. */
export class InvalidExpertProfileError extends Error {
  constructor(invalidIds: string[]) {
    super(
      `Invalid expert profile id(s): ${invalidIds.join(', ')}. ` +
        `Valid ids: ${EXPERT_PROFILE_IDS.join(', ')}.`,
    );
    this.name = 'InvalidExpertProfileError';
  }
}

/** Raised when more than 3 expert profiles are requested for one task. */
export class TooManyExpertProfilesError extends Error {
  constructor(ids: string[]) {
    super(`At most 3 expert profiles allowed, got ${ids.length}: ${ids.join(', ')}`);
    this.name = 'TooManyExpertProfilesError';
  }
}

/**
 * Validate expert profile ids BEFORE any model call is made. Fails loud and
 * early — an invalid id must never reach a rendered brief or a spawned task.
 */
export function validateProfiles(ids: string[]): void {
  const invalid = ids.filter((id) => !EXPERT_PROFILE_MAP.has(id));
  if (invalid.length > 0) throw new InvalidExpertProfileError(invalid);
  if (ids.length > 3) throw new TooManyExpertProfilesError(ids);
}

export interface RouteInput {
  role: ModelRole;
  stage?: Stage;
  requirement_tags?: string[];
  paths?: string[];
  high_risk?: boolean;
}

export interface RouteResult {
  primary: string;
  complementary: string[];
  mode: 'embed' | 'consult';
}

const MAX_TOTAL_TOKEN_BUDGET = 1500;

interface StageRoute {
  primary: string;
  complementary?: string[];
}

/** Stage -> profile mapping. Stages absent here fall back to ROLE_DEFAULT. */
const STAGE_PROFILES: Partial<Record<Stage, StageRoute>> = {
  SPEC_READY: { primary: 'product-manager', complementary: ['system-architect'] },
  PLAN: { primary: 'product-manager', complementary: ['system-architect'] },
  PLAN_REVIEW: { primary: 'product-manager', complementary: ['system-architect'] },
  EXECUTE: { primary: 'senior-software-engineer' },
  // reviewer role NEVER inherits the authoral profile here: default lens is
  // test coverage; a security tag (handled below) swaps it to security-engineer.
  CODE_REVIEW: { primary: 'test-architect' },
  UI_SMOKE: { primary: 'ux-product-designer', complementary: ['test-architect'] },
  JOURNEYS: { primary: 'ux-product-designer', complementary: ['test-architect'] },
  RESEARCH: { primary: 'discovery-analyst' },
  RESEARCH_DELTA: { primary: 'discovery-analyst' },
  DIAGNOSE: { primary: 'debugger' },
  REPRODUCE: { primary: 'debugger' },
  REPAIR: { primary: 'debugger' },
};

/** Role -> profile fallback used when no stage is given or the stage has no mapping. */
const ROLE_DEFAULT: Record<ModelRole, StageRoute> = {
  lead: { primary: 'system-architect' },
  reviewer: { primary: 'test-architect' },
  planner: { primary: 'product-manager', complementary: ['system-architect'] },
  worker: { primary: 'senior-software-engineer' },
  researcher: { primary: 'discovery-analyst' },
  qa: { primary: 'ux-product-designer', complementary: ['test-architect'] },
};

const isDocsPath = (p: string): boolean => /\.md$/i.test(p);
const isInfraPath = (p: string): boolean =>
  /(^|\/)Dockerfile(\.[\w.-]+)?$/i.test(p) || p.includes('.github/') || /(^|\/)deploy(\/|$)/i.test(p);

/** Dedupe an ordered list, keeping first occurrence, without mutating input. */
function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Deterministic expert-profile router: same input always yields the same
 * output. No randomness, no ambient state, no object-key-order dependence.
 *
 * Resolution order:
 * 1. stage mapping (or role default fallback when the stage is unmapped)
 * 2. CODE_REVIEW security-tag swap (test-architect -> security-engineer)
 * 3. pure-docs / pure-infra path override (promotes technical-writer /
 *    devops-sre to primary when EVERY given path matches that category)
 * 4. security tag ensures security-engineer is present somewhere in the set
 * 5. researcher role is forced down to exactly 1 profile (read-only research
 *    never gets a complementary lens)
 * 6. complementary capped at 2 (total <= 3) and the combined token_budget
 *    capped at 1500 by dropping complementary entries from the tail
 */
export function routeProfiles(input: RouteInput): RouteResult {
  const { role, stage, requirement_tags = [], paths = [], high_risk = false } = input;

  const base = (stage && STAGE_PROFILES[stage]) ?? ROLE_DEFAULT[role];
  let primary = base.primary;
  let complementary = [...(base.complementary ?? [])];

  // CODE_REVIEW never inherits the authoral (senior-software-engineer) profile;
  // a security tag swaps the lens from test coverage to threat analysis.
  if (stage === 'CODE_REVIEW' && requirement_tags.includes('security')) {
    primary = 'security-engineer';
    complementary = ['test-architect'];
  }

  // Pure-category path signals override the primary; the previous primary is
  // kept as a complementary hint instead of being discarded.
  if (paths.length > 0 && paths.every(isDocsPath) && primary !== 'technical-writer') {
    complementary = [primary, ...complementary];
    primary = 'technical-writer';
  } else if (paths.length > 0 && paths.every(isInfraPath) && primary !== 'devops-sre') {
    complementary = [primary, ...complementary];
    primary = 'devops-sre';
  }

  // A security tag always guarantees a security-engineer lens is present.
  if (requirement_tags.includes('security') && primary !== 'security-engineer') {
    complementary = [...complementary, 'security-engineer'];
  }

  complementary = dedupe(complementary).filter((id) => id !== primary);

  // Read-only research is a single-lens operation by definition.
  if (role === 'researcher') complementary = [];

  complementary = complementary.slice(0, 2);

  // Token budget cap: keep primary always, drop complementary from the tail.
  const budgetOf = (id: string) => EXPERT_PROFILE_MAP.get(id)?.token_budget ?? 0;
  let total = budgetOf(primary);
  const kept: string[] = [];
  for (const id of complementary) {
    const next = total + budgetOf(id);
    if (next > MAX_TOTAL_TOKEN_BUDGET) break;
    kept.push(id);
    total = next;
  }
  complementary = kept;

  const result: RouteResult = { primary, complementary, mode: high_risk ? 'consult' : 'embed' };
  validateProfiles([result.primary, ...result.complementary]);
  return result;
}
