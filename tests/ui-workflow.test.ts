import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { uiWorkflow } from '../src/workflows/ui.js';
import { RijoPaths } from '../src/core/paths.js';
import { tmpProject, cleanup, writePlanFile, deps, ok, wireUi, UI_MAPPING_PAYLOAD } from './helpers.js';

const IMPORT_ID = '202607231200'; // fixed by helpers' now()

describe('rijo ui (hardened import pipeline)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
    writePlanFile(root);
  });
  afterEach(() => cleanup(root));

  function makeDesignZip(name = 'design.zip'): string {
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html><body><h1>Home</h1></body></html>'));
    zip.addFile('about.html', Buffer.from('<html><body>About</body></html>'));
    zip.addFile('assets/logo.svg', Buffer.from('<svg/>'));
    zip.addFile('mock-data.json', Buffer.from('{"products": []}'));
    const p = path.join(root, name);
    zip.writeZip(p);
    return p;
  }

  function makeMaliciousZip(): string {
    // adm-zip sanitizes traversal names on write, so binary-patch the entry
    // name after building to produce a genuinely hostile archive.
    const zip = new AdmZip();
    zip.addFile('AAAAAAevil.txt', Buffer.from('pwned'));
    let buf = zip.toBuffer();
    const from = Buffer.from('AAAAAAevil.txt');
    const to = Buffer.from('../../evil.txt');
    let i: number;
    while ((i = buf.indexOf(from)) !== -1) to.copy(buf, i);
    const p = path.join(root, 'malicious.zip');
    fs.writeFileSync(p, buf);
    return p;
  }

  it('rejects a malicious ZIP (path traversal)', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zipPath = makeMaliciousZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/rejected/i);
    // nothing escaped the workspace
    expect(fs.existsSync(path.join(root, '..', 'evil.txt'))).toBe(false);
  });

  it('happy path: mapping, isolated conversion, browser validation and applied patch', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.ok, outcome.message + ' :: ' + (outcome.details ?? []).join(' | ')).toBe(true);

    const importDir = path.join(new RijoPaths(root).importsDir, IMPORT_ID);

    const inventory = fs.readFileSync(path.join(importDir, 'INVENTORY.md'), 'utf8');
    expect(inventory).toContain('index.html');
    expect(inventory).toContain('assets/logo.svg');
    expect(inventory).toContain('mock-data.json');

    const mapping = fs.readFileSync(path.join(importDir, 'MAPPING.md'), 'utf8');
    expect(mapping).toContain('app/page.tsx');
    for (const state of ['loading', 'empty', 'error', 'success']) {
      expect(mapping).toContain(state);
    }

    expect(fs.existsSync(path.join(importDir, 'IMPORT.md'))).toBe(true);

    // the patch was applied to the checkout — converted files actually exist in the project
    for (const dest of UI_MAPPING_PAYLOAD.mappings.map((m) => m.to)) {
      expect(fs.existsSync(path.join(root, dest)), `expected ${dest} to exist in the checkout`).toBe(true);
    }
  });

  it('blocks when mocks remain in the production path (deterministic scan on real files)', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, {
      convert: (t) => {
        const base = t.workspace!.root;
        for (const scope of t.write_scope) {
          fs.mkdirSync(path.dirname(path.join(base, scope)), { recursive: true });
          fs.writeFileSync(path.join(base, scope), 'export const MOCK_PRODUCTS = [];\n');
        }
        return ok(t, { payload: { converted: true, components_created: t.write_scope, notes: 'converted' } });
      },
    });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('mocks/placeholders in the production path (deterministic scan)');
    // nothing was applied to the checkout
    expect(fs.existsSync(path.join(root, 'app/page.tsx'))).toBe(false);
  });

  it('blocks on an invalid mapping write scope (glob destination)', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, {
      mapping: {
        ...UI_MAPPING_PAYLOAD,
        mappings: [{ from: 'index.html', to: 'app/**', kind: 'component', notes: 'invalid' }],
      },
    });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('invalid write scope');
  });

  it('blocks when the mapping does not plan all required UI states', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, {
      mapping: { ...UI_MAPPING_PAYLOAD, states_covered: ['loading', 'empty', 'success'] },
    });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('required UI states');
  });

  it('blocks a page import when no real browser runtime is available', async () => {
    const d = deps(root, { capabilities: { browser: false } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('browser validation runtime');
  });

  it('an executable inside the zip is not extracted', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    zip.addFile('tools/helper.exe', Buffer.from('MZ...'));
    const p = path.join(root, 'design-exe.zip');
    zip.writeZip(p);
    const outcome = await uiWorkflow(root, { input: '@design-exe.zip' }, d);
    expect(outcome.ok, outcome.message + ' :: ' + (outcome.details ?? []).join(' | ')).toBe(true);
    const staging = path.join(new RijoPaths(root).importsDir, IMPORT_ID, 'staging');
    expect(fs.existsSync(path.join(staging, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'tools', 'helper.exe'))).toBe(false);
    const inventory = fs.readFileSync(path.join(new RijoPaths(root).importsDir, IMPORT_ID, 'INVENTORY.md'), 'utf8');
    expect(inventory).toContain('Executable not extracted');
  });

  it('discards a conversion that writes outside its derived write scope (nothing applied)', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, {
      convert: (t) => {
        const base = t.workspace!.root;
        for (const scope of t.write_scope) {
          fs.mkdirSync(path.dirname(path.join(base, scope)), { recursive: true });
          fs.writeFileSync(path.join(base, scope), `// converted ${scope}\nexport default function Page() { return null; }\n`);
        }
        // rogue write outside the mapping-derived scope
        fs.mkdirSync(path.join(base, 'app'), { recursive: true });
        fs.writeFileSync(path.join(base, 'app', 'rogue.ts'), '// outside scope\n');
        return ok(t, { payload: { converted: true, components_created: t.write_scope, notes: 'converted' } });
      },
    });
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('outside its individual write scope');
    expect(fs.existsSync(path.join(root, 'app/page.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'app/rogue.ts'))).toBe(false);
  });
});
