import type { ModelRole, RijoConfig } from '../core/schemas/index.js';

/** Resolve the configured tier string for a role. Core never names models. */
export function tierFor(config: RijoConfig, role: ModelRole): string {
  return config.models[role];
}

export function limitsFor(config: RijoConfig) {
  return config.limits;
}
