import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Deterministic mock/placeholder scan for UI imports. The agent's payload is
 * NEVER accepted as proof of absence — the core scans the real files that
 * changed. A finding blocks the import; nothing is applied.
 */

export interface MockFinding {
  file: string;
  line: number;
  pattern: string;
  excerpt: string;
}

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.html', '.htm', '.css', '.json']);

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'mock-library-import', re: /from\s+['"](msw|json-server|miragejs|@faker-js\/faker|faker)['"]/ },
  { name: 'mock-identifier', re: /\b(MOCK_[A-Z_]+|mockData|fakeData|dummyData|sampleUsers|stubResponse)\b/ },
  { name: 'mock-endpoint', re: /['"`][^'"`]*\/(api\/)?mock[s]?\/[^'"`]*['"`]/i },
  { name: 'lorem-ipsum', re: /lorem ipsum/i },
  { name: 'fake-latency-handler', re: /setTimeout\s*\([^)]*resolve/ },
  { name: 'temporary-handler-marker', re: /\b(TODO|FIXME|TBD)\b.*(handler|endpoint|api|fetch|remove)/i },
  { name: 'hardcoded-localhost-data', re: /fetch\(\s*['"`]http:\/\/localhost:\d+\/(?!api\b)[^'"`]*mock/i },
];

export function scanForMocks(root: string, files: string[]): MockFinding[] {
  const findings: MockFinding[] = [];
  for (const rel of files) {
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
    const full = path.join(root, rel);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const p of PATTERNS) {
        if (p.re.test(lines[i]!)) {
          findings.push({ file: rel, line: i + 1, pattern: p.name, excerpt: lines[i]!.trim().slice(0, 160) });
        }
      }
    }
  }
  return findings;
}
