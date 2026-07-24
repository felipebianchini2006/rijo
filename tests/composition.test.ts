import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { readRoadmap } from '../src/core/roadmap.js';
import { tmpProject, cleanup, writePlanFile, deps, ok, wireUi } from './helpers.js';

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
    const d = deps(root, { capabilities: { subagents: true, parallelism: true, browser: true } });
    wireUi(d, root);
    // browser:true also activates run.ts's per-phase UI_SMOKE gate for
    // ui_surface phases (independent of the ui import pipeline itself).
    d.runner.on(
      (t) => t.id.startsWith('ui-smoke-'),
      (t) => ok(t, { payload: { passed: true, console_errors: [], network_errors: [], screenshot: null, notes: 'smoke ok' } }),
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
