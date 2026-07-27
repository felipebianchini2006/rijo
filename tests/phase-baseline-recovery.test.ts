import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPhaseExecutionBaseline } from '../src/workflows/run.js';
import { cleanup, tmpProject } from './helpers.js';

describe('phase execution baseline recovery', () => {
  let root = '';

  afterEach(() => {
    if (root) cleanup(root);
  });

  it('retains an existing source baseline when all task projections are pending', () => {
    root = tmpProject('rijo-phase-baseline-');
    const target = path.join(root, '.rijo', 'runtime', 'phase-baselines', 'M001-01.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      target,
      `${JSON.stringify({
        snapshot: [],
        controlled_snapshot: [['server.mjs', 'verified-source-hash']],
        dirty_at_start: [],
      })}\n`,
    );

    const recovered = readPhaseExecutionBaseline(target);

    expect(recovered).not.toBeNull();
    expect(recovered?.snapshot.has('server.mjs')).toBe(false);
    expect(recovered?.controlledSnapshot.get('server.mjs')).toBe('verified-source-hash');
  });
});
