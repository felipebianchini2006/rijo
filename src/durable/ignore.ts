import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/fsx.js';

const DURABLE_IGNORES = [
  'runtime/',
  'state/rijo.db',
  'state/rijo.db-wal',
  'state/rijo.db-shm',
  'state/backups/',
] as const;

export function ensureDurableGitignore(projectRoot: string): string[] {
  const target = path.join(projectRoot, '.rijo', '.gitignore');
  const existing = fs.existsSync(target)
    ? fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const lines = [...existing];
  for (const pattern of DURABLE_IGNORES) {
    if (!lines.includes(pattern)) lines.push(pattern);
  }
  writeFileAtomic(target, `${lines.join('\n')}\n`);
  return lines;
}
