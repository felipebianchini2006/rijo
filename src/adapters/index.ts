import { generateClaudeAdapter, detectClaude } from './claude.js';
import { generateCodexAdapter, detectCodex } from './codex.js';
import { generateGenericAdapter } from './generic.js';
import type { AdapterReport } from './shared.js';

export type AdapterName = 'claude' | 'codex' | 'generic';

/**
 * Generate adapters relevant to the detected runtime. Detection is
 * filesystem-based; `force` overrides for tests and explicit installs.
 */
export function generateAdapters(projectRoot: string, force?: AdapterName[]): AdapterReport {
  const report: AdapterReport = { generated: [], skipped: [], notes: [] };
  const merge = (r: AdapterReport) => {
    report.generated.push(...r.generated);
    report.skipped.push(...r.skipped);
    report.notes.push(...r.notes);
  };
  const wants = (name: AdapterName, detected: boolean) => (force ? force.includes(name) : detected);

  const claude = wants('claude', detectClaude(projectRoot));
  const codex = wants('codex', detectCodex(projectRoot));
  if (claude) merge(generateClaudeAdapter(projectRoot));
  if (codex) merge(generateCodexAdapter(projectRoot));
  if (!claude && !codex) merge(generateGenericAdapter(projectRoot));
  return report;
}

export { generateClaudeAdapter, generateCodexAdapter, generateGenericAdapter };
