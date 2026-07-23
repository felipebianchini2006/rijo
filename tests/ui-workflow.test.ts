import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { uiWorkflow } from '../src/workflows/ui.js';
import { RijoPaths } from '../src/core/paths.js';
import { tmpProject, cleanup, writePlanFile, deps, ok } from './helpers.js';

const IMPORT_ID = '202607231200'; // fixed by helpers' now()

describe('rijo ui', () => {
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

  function wireConversion(d: ReturnType<typeof deps>, opts: { remainingMocks?: string[]; writeMapping?: boolean } = {}) {
    d.runner.on(
      (t) => t.id.startsWith('ui-convert'),
      (t) => {
        if (opts.writeMapping !== false) {
          const mappingPath = path.join(root, '.rijo', 'imports', IMPORT_ID, 'MAPPING.md');
          fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
          fs.writeFileSync(mappingPath, '# Mapping\n\n| origem | destino |\n|---|---|\n| index.html | app/page.tsx |\n');
        }
        return ok(t, {
          payload: {
            converted: true,
            components_created: ['app/page.tsx', 'app/about/page.tsx'],
            routes_mapped: [{ from: 'index.html', to: '/' }, { from: 'about.html', to: '/about' }],
            mocks_removed: ['mock-data.json'],
            remaining_mocks: opts.remainingMocks ?? [],
            api_contracts: ['src/lib/api/products.ts'],
            notes: 'convertido para o stack detectado',
          },
        });
      },
    );
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

  it('converts a design zip: inventory, mapping, routes and no mocks in production path', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireConversion(d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.ok, outcome.message).toBe(true);

    const importDir = path.join(new RijoPaths(root).importsDir, IMPORT_ID);
    const inventory = fs.readFileSync(path.join(importDir, 'INVENTORY.md'), 'utf8');
    expect(inventory).toContain('index.html');
    expect(inventory).toContain('assets/logo.svg');
    expect(inventory).toContain('mock-data.json');

    const mapping = fs.readFileSync(path.join(importDir, 'MAPPING.md'), 'utf8');
    expect(mapping).toContain('app/page.tsx');

    const importDoc = fs.readFileSync(path.join(importDir, 'IMPORT.md'), 'utf8');
    expect(importDoc).toContain('untrusted input');
    // browser unavailable → validation recorded as skipped, never simulated
    expect(importDoc).toContain('SKIPPED');
  });

  it('blocks when mocks remain in the production path', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireConversion(d, { remainingMocks: ['src/lib/mock-products.ts'] });
    const outcome = await uiWorkflow(root, { input: `@${path.basename(makeDesignZip())}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('mocks');
  });

  it('blocks when MAPPING.md is not produced', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireConversion(d, { writeMapping: false });
    const outcome = await uiWorkflow(root, { input: `@${path.basename(makeDesignZip())}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('MAPPING.md');
  });

  it('an executable inside the zip is not extracted', async () => {
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    wireConversion(d);
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    zip.addFile('tools/helper.exe', Buffer.from('MZ...'));
    const p = path.join(root, 'design-exe.zip');
    zip.writeZip(p);
    const outcome = await uiWorkflow(root, { input: '@design-exe.zip' }, d);
    expect(outcome.ok, outcome.message).toBe(true);
    const staging = path.join(new RijoPaths(root).importsDir, IMPORT_ID, 'staging');
    expect(fs.existsSync(path.join(staging, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'tools', 'helper.exe'))).toBe(false);
    const inventory = fs.readFileSync(path.join(new RijoPaths(root).importsDir, IMPORT_ID, 'INVENTORY.md'), 'utf8');
    expect(inventory).toContain('Executable not extracted');
  });
});
