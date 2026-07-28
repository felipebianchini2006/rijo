import * as fs from 'node:fs';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newWorkflow } from '../src/workflows/new.js';
import { uiWorkflow } from '../src/workflows/ui.js';
import { tmpProject, cleanup, writePlanFile, deps, ok, wireUi, UI_MAPPING_PAYLOAD, uiOperation } from './helpers.js';

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
    zip.addFile('assets/photo.png', Buffer.from([0, 1, 2, 255]));
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
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zipPath = makeMaliciousZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/rejected/i);
    // nothing escaped the workspace
    expect(fs.existsSync(path.join(root, '..', 'evil.txt'))).toBe(false);
  });

  it('rejects a symbolic-link directory input before it reads local files', async () => {
    if (process.platform === 'win32') return;
    const outside = tmpProject('rijo-ui-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'local secret');
    fs.symlinkSync(outside, path.join(root, 'design-link'), 'dir');
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const ui = uiOperation(root, d);

    const outcome = await uiWorkflow(root, { input: '@design-link' }, ui.deps);

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toMatch(/symbolic link/i);
    expect(
      fs.existsSync(path.join(ui.importDir, 'staging', 'secret.txt')),
    ).toBe(false);
    cleanup(outside);
  });

  it('happy path: mapping, isolated conversion, browser validation and applied patch', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zipPath = makeDesignZip();
    const ui = uiOperation(root, d);
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, ui.deps);
    expect(outcome.ok, outcome.message + ' :: ' + (outcome.details ?? []).join(' | ')).toBe(true);

    const importDir = ui.importDir;

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
    expect(fs.existsSync(path.join(importDir, 'VISUAL-COMPARISON.md'))).toBe(true);

    // the patch was applied to the checkout — converted files actually exist in the project
    for (const dest of UI_MAPPING_PAYLOAD.mappings.map((m) => m.to)) {
      expect(fs.existsSync(path.join(root, dest)), `expected ${dest} to exist in the checkout`).toBe(true);
    }
  });

  it('merges HTML and ZIP inputs, deduplicates identical paths, and references binary assets', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zipPath = makeDesignZip();
    fs.writeFileSync(
      path.join(root, 'index.html'),
      '<html><body><h1>Home</h1></body></html>',
    );

    const ui = uiOperation(root, d);
    const outcome = await uiWorkflow(
      root,
      { inputs: ['@index.html', `@${path.basename(zipPath)}`] },
      ui.deps,
    );

    expect(outcome.ok, outcome.message).toBe(true);
    const importDir = ui.importDir;
    expect(
      fs.readdirSync(path.join(importDir, 'staging')).filter((name) => name === 'index.html'),
    ).toHaveLength(1);
    const artifacts = JSON.parse(
      fs.readFileSync(path.join(importDir, 'ARTIFACTS.json'), 'utf8'),
    );
    expect(artifacts.primary_html).toBe('index.html');
    expect(artifacts.artifacts).toEqual([
      expect.objectContaining({
        staged_path: 'staging/assets/photo.png',
        size: 4,
        media_type: 'image/png',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('preserves a mapped binary asset byte for byte through the isolated conversion', async () => {
    const binary = Buffer.from([0, 1, 2, 255]);
    const mapping = {
      ...UI_MAPPING_PAYLOAD,
      mappings: [
        { from: 'index.html', to: 'app/page.tsx', kind: 'component', notes: 'home' },
        { from: 'assets/photo.png', to: 'public/photo.png', kind: 'asset', notes: 'photo' },
      ],
      routes: [{ from: 'index.html', to: '/' }],
    };
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, {
      mapping,
      convert: (task) => {
        const page = path.join(task.workspace!.root, 'app/page.tsx');
        fs.mkdirSync(path.dirname(page), { recursive: true });
        fs.writeFileSync(page, 'export default function Page() { return null; }\n');
        return ok(task, {
          files_written: ['app/page.tsx'],
          payload: { converted: true, components_created: task.write_scope, notes: 'converted' },
        });
      },
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await uiWorkflow(root, { input: `@${path.basename(makeDesignZip())}` }, d);

    expect(outcome.ok, outcome.message).toBe(true);
    expect(fs.readFileSync(path.join(root, 'public/photo.png'))).toEqual(binary);
  });

  it('blocks when a mapped destination is missing from the conversion', async () => {
    const mapping = {
      ...UI_MAPPING_PAYLOAD,
      mappings: [
        { from: 'index.html', to: 'app/page.tsx', kind: 'component', notes: 'home' },
        { from: 'about.html', to: 'app/about/page.tsx', kind: 'component', notes: 'about' },
      ],
    };
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, {
      mapping,
      convert: (task) => {
        const page = path.join(task.workspace!.root, 'app/page.tsx');
        fs.mkdirSync(path.dirname(page), { recursive: true });
        fs.writeFileSync(page, 'export default function Page() { return null; }\n');
        return ok(task, {
          files_written: ['app/page.tsx'],
          payload: { converted: true, components_created: ['app/page.tsx'], notes: 'partial' },
        });
      },
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await uiWorkflow(root, { input: `@${path.basename(makeDesignZip())}` }, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('mapped destinations');
    expect(outcome.details).toContain('app/about/page.tsx');
  });

  it('blocks mappings that collide on the same destination', async () => {
    const mapping = {
      ...UI_MAPPING_PAYLOAD,
      mappings: [
        { from: 'index.html', to: 'public/collision.png', kind: 'component', notes: 'page' },
        { from: 'assets/photo.png', to: 'public/collision.png', kind: 'asset', notes: 'photo' },
      ],
    };
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, { mapping });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await uiWorkflow(root, { input: `@${path.basename(makeDesignZip())}` }, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('invalid write scope');
    expect(outcome.details?.join('\n')).toContain('duplicate destination');
  });

  it('blocks when the converter corrupts a staged binary asset', async () => {
    const mapping = {
      ...UI_MAPPING_PAYLOAD,
      mappings: [
        { from: 'index.html', to: 'app/page.tsx', kind: 'component', notes: 'home' },
        { from: 'assets/photo.png', to: 'public/photo.png', kind: 'asset', notes: 'photo' },
      ],
      routes: [{ from: 'index.html', to: '/' }],
    };
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root, {
      mapping,
      convert: (task) => {
        const page = path.join(task.workspace!.root, 'app/page.tsx');
        const photo = path.join(task.workspace!.root, 'public/photo.png');
        fs.mkdirSync(path.dirname(page), { recursive: true });
        fs.mkdirSync(path.dirname(photo), { recursive: true });
        fs.writeFileSync(page, 'export default function Page() { return null; }\n');
        fs.writeFileSync(photo, Buffer.from('corrupt'));
        return ok(task, {
          files_written: ['app/page.tsx', 'public/photo.png'],
          payload: { converted: true, components_created: task.write_scope, notes: 'converted' },
        });
      },
    });
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);

    const outcome = await uiWorkflow(root, { input: `@${path.basename(makeDesignZip())}` }, d);

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('binary asset integrity');
    expect(fs.existsSync(path.join(root, 'public/photo.png'))).toBe(false);
  });

  it('blocks a path collision with different content', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zipPath = makeDesignZip();
    fs.writeFileSync(path.join(root, 'index.html'), '<html>Different design</html>');

    const outcome = await uiWorkflow(
      root,
      { inputs: ['@index.html', `@${path.basename(zipPath)}`] },
      d,
    );

    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('Path collision has different content');
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
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
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
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
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
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('required UI states');
  });

  it('blocks a page import when no real browser runtime is available', async () => {
    const d = deps(root, { capabilities: { browser: false } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('browser validation runtime');
  });

  it('an executable inside the zip is not extracted', async () => {
    const d = deps(root, { capabilities: { browser: true } });
    wireUi(d, root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html/>'));
    zip.addFile('tools/helper.exe', Buffer.from('MZ...'));
    const p = path.join(root, 'design-exe.zip');
    zip.writeZip(p);
    const ui = uiOperation(root, d);
    const outcome = await uiWorkflow(root, { input: '@design-exe.zip' }, ui.deps);
    expect(outcome.ok, outcome.message + ' :: ' + (outcome.details ?? []).join(' | ')).toBe(true);
    const staging = path.join(ui.importDir, 'staging');
    expect(fs.existsSync(path.join(staging, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'tools', 'helper.exe'))).toBe(false);
    const inventory = fs.readFileSync(path.join(ui.importDir, 'INVENTORY.md'), 'utf8');
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
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const zipPath = makeDesignZip();
    const outcome = await uiWorkflow(root, { input: `@${path.basename(zipPath)}` }, d);
    expect(outcome.status).toBe('blocked');
    expect(outcome.message).toContain('outside its individual write scope');
    expect(fs.existsSync(path.join(root, 'app/page.tsx'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'app/rogue.ts'))).toBe(false);
  });
});
