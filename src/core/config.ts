import YAML from 'yaml';
import { ConfigSchema, type RijoConfig } from './schemas/index.js';
import { readTextIfExists, writeFileAtomic } from './fsx.js';
import type { RijoPaths } from './paths.js';

export function loadConfig(paths: RijoPaths): RijoConfig {
  const raw = readTextIfExists(paths.config);
  if (raw === null) return ConfigSchema.parse({});
  const parsed = YAML.parse(raw) ?? {};
  return ConfigSchema.parse(parsed);
}

export function saveConfig(paths: RijoPaths, config: RijoConfig): void {
  writeFileAtomic(paths.config, YAML.stringify(config, { lineWidth: 0 }));
}

export function defaultConfig(): RijoConfig {
  return ConfigSchema.parse({});
}
