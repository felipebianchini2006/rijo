import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRoadmap } from '../src/core/roadmap.js';
import { tmpProject, cleanup, writePlanFile, deps, ok } from './helpers.js';

const IMPORT_ID = '202607231200'; // fixed by helpers' now()

function milestoneDir(root: string): string {
  const paths = new RijoPaths(root);
  const m = readManifest(paths)!;
  const entry = m.milestones.find((x) => x.id === m.active_milestone)!;
  return paths.milestoneDir(entry.id, entry.slug);
}

describe('new → ui → run composition (single lock, no double-acquire)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html><body>Home</body></html>'));
    zip.writeZip(path.join(root, 'design.zip'));
  });
  afterEach(() => cleanup(root));

  it('runs new, then ui import, then all phases without a lock deadlock', async () => {
    const d = deps(root, { capabilities: { subagents: true, parallelism: true, browser: false } });
    // wire the ui conversion handler to write MAPPING.md and report clean
    d.runner.on(
      (t) => t.id.startsWith('ui-convert'),
      (t) => {
        const mapping = path.join(root, '.rijo', 'imports', IMPORT_ID, 'MAPPING.md');
        fs.mkdirSync(path.dirname(mapping), { recursive: true });
        fs.writeFileSync(mapping, '# Mapping\n\n| index.html | app/page.tsx |\n');
        return ok(t, {
          payload: { converted: true, components_created: ['app/page.tsx'], routes_mapped: [{ from: 'index.html', to: '/' }], mocks_removed: [], remaining_mocks: [], api_contracts: [], notes: 'ok' },
        });
      },
    );

    const outcome = await newWorkflow(root, { planFile: '@PLANO.md', ui: '@design.zip', run: true }, d);
    expect(outcome.ok, outcome.message + ' :: ' + (outcome.details ?? []).join(' | ')).toBe(true);

    // ui import happened
    expect(fs.existsSync(path.join(new RijoPaths(root).importsDir, IMPORT_ID, 'MAPPING.md'))).toBe(true);
    // and all phases ran to DONE (run composed in the same lock)
    const roadmap = readRoadmap(path.join(milestoneDir(root), 'ROADMAP.md'));
    expect(roadmap.phases.every((p) => p.status === 'DONE')).toBe(true);
    // the lock file is released at the end
    expect(fs.existsSync(new RijoPaths(root).lock)).toBe(false);
  });
});
