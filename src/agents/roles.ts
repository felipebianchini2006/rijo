import type { ClaudeTier, CodexTier, ModelRole, RijoConfig } from '../core/schemas/index.js';

/** Resolve the configured tier string for a role. Core never names models. */
export function tierFor(config: RijoConfig, role: ModelRole): string {
  return config.models[role];
}

export function limitsFor(config: RijoConfig) {
  return config.limits;
}

/**
 * Raised when a tier cannot be mapped to a concrete provider model. Fails loud
 * instead of guessing a model: routing is operational and must be explicit.
 */
export class ModelResolutionError extends Error {
  constructor(provider: 'claude' | 'codex', tier: string, role: ModelRole) {
    super(
      `No ${provider} provider mapping for role "${role}" (tier "${tier}"). ` +
        `Add providers.${provider}.${tier} to .rijo/config.yml.`,
    );
    this.name = 'ModelResolutionError';
  }
}

/**
 * Resolve a concrete Claude model+effort for a tier, falling back to the tier
 * the role maps to in `config.models` when the requested tier is absent from
 * the provider table. Never invents a model — throws ModelResolutionError when
 * neither the requested tier nor the role's tier is present.
 */
export function resolveClaudeTier(config: RijoConfig, tier: string, role: ModelRole): ClaudeTier {
  const map = config.providers.claude;
  const conf = map[tier] ?? map[config.models[role]];
  if (!conf) throw new ModelResolutionError('claude', tier, role);
  return conf;
}

/** Same as resolveClaudeTier but for Codex model+reasoning_effort tiers. */
export function resolveCodexTier(config: RijoConfig, tier: string, role: ModelRole): CodexTier {
  const map = config.providers.codex;
  const conf = map[tier] ?? map[config.models[role]];
  if (!conf) throw new ModelResolutionError('codex', tier, role);
  return conf;
}

/** Concrete Claude model for a role using the role's configured tier. */
export function claudeTierForRole(config: RijoConfig, role: ModelRole): ClaudeTier {
  return resolveClaudeTier(config, config.models[role], role);
}

/** Concrete Codex model for a role using the role's configured tier. */
export function codexTierForRole(config: RijoConfig, role: ModelRole): CodexTier {
  return resolveCodexTier(config, config.models[role], role);
}
