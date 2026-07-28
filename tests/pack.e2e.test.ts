import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { cleanup, tmpProject } from './helpers.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

interface PackFileEntry {
  path: string;
}
interface PackEntry {
  filename: string;
  files: PackFileEntry[];
}

/** npm pack --json may be preceded by lifecycle noise; parse from the first '['. */
function parsePackJson(stdout: string): PackEntry[] {
  const start = stdout.indexOf('[');
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as PackEntry[];
}

/** Run a child without a shell while leaving the Vitest worker event loop free. */
async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

describe('distribution E2E (npm pack + install)', () => {
  test('tarball installs and the CLI works from dist', async () => {
    // ---- pack (prepack runs the tsc build)
    const packOut = await run('npm', ['pack', '--json'], packageRoot);
    const [entry] = parsePackJson(packOut);
    expect(entry).toBeDefined();
    const tarball = path.join(packageRoot, entry!.filename);
    expect(fs.existsSync(tarball)).toBe(true);

    const fixture = tmpProject('rijo-pack-e2e-');
    try {
      // ---- tarball contents: no sources or tests shipped
      const shippedPaths = entry!.files.map((f) => f.path.replace(/\\/g, '/'));
      expect(shippedPaths.some((p) => p === 'src' || p.startsWith('src/'))).toBe(false);
      expect(shippedPaths.some((p) => p === 'tests' || p.startsWith('tests/'))).toBe(false);
      expect(shippedPaths.some((p) => p.startsWith('dist/'))).toBe(true);
      expect(shippedPaths.some((p) => p.startsWith('skills/'))).toBe(true);
      expect(shippedPaths).toContain('dist/cli/index.js');
      expect(shippedPaths).toContain('skills/rijo-new.md');

      // ---- run the packed CLI through npm in an empty folder. The installer
      // must bootstrap this exact package without a registry lookup.
      await run(
        'npm',
        [
          'exec',
          '--yes',
          '--package',
          tarball,
          '--',
          'rijo',
          'install',
          '--project',
          '--codex',
        ],
        fixture,
      );

      const installed = path.join(fixture, 'node_modules', 'rijo');
      expect(fs.existsSync(path.join(installed, 'dist', 'cli', 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(installed, 'skills', 'rijo-new.md'))).toBe(true);
      expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);

      // package.json "files" also lists templates/, schemas/, adapters/ — only
      // assert what actually exists in the repo (npm skips missing entries).
      for (const optional of ['templates', 'schemas', 'adapters']) {
        if (fs.existsSync(path.join(packageRoot, optional))) {
          expect(fs.existsSync(path.join(installed, optional))).toBe(true);
        }
      }

      const cliEntry = path.join('node_modules', 'rijo', 'dist', 'cli', 'index.js');

      // ---- rijo --version
      const version = await run(process.execPath, [cliEntry, '--version'], fixture);
      expect(version.trim()).toBe('0.2.0-rc.1');

      // ---- rijo --status --json on the uninitialized fixture
      const statusOut = await run(process.execPath, [cliEntry, '--status', '--json'], fixture);
      const status = JSON.parse(statusOut);
      expect(status.initialized).toBe(false);
      expect(status.rijo_version).toBe('0.2.0-rc.1');
      expect(status.schema_version).toBe(4);
      expect(status.native_workflow).toBeNull();

      // ---- project binding: the public manifest and lock root use the exact
      // semantic version even though npm received a local package source.
      const boundManifest = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
      expect(boundManifest.devDependencies.rijo).toBe('0.2.0-rc.1');
      const boundLock = JSON.parse(fs.readFileSync(path.join(fixture, 'package-lock.json'), 'utf8'));
      expect(boundLock.packages[''].devDependencies.rijo).toBe('0.2.0-rc.1');
      expect(boundLock.packages['node_modules/rijo'].version).toBe('0.2.0-rc.1');
      const localVersion = await run(process.execPath, ['.rijo/bin/rijo.cjs', '--version'], fixture);
      expect(localVersion.trim()).toBe('0.2.0-rc.1');

      // ---- repeat the public project install through the bound local CLI.
      // The second run must preserve every binding and provider byte.
      const idempotentFiles = [
        'package.json',
        'package-lock.json',
        '.rijo/bin/rijo.cjs',
        '.rijo/tooling-binding.json',
        '.agents/skills/rijo/SKILL.md',
        'AGENTS.md',
      ];
      const firstInstall = idempotentFiles.map((file) =>
        fs.readFileSync(path.join(fixture, file)),
      );
      await run(
        process.execPath,
        ['.rijo/bin/rijo.cjs', 'install', '--project', '--codex'],
        fixture,
      );
      const secondInstall = idempotentFiles.map((file) =>
        fs.readFileSync(path.join(fixture, file)),
      );
      expect(secondInstall).toEqual(firstInstall);

      // ---- P0.2: the published programmatic API is importable from the tarball.
      // The audit reproduced ERR_MODULE_NOT_FOUND here before package "exports"
      // existed; this proves `import { runWorkflow } from 'rijo'` resolves.
      fs.writeFileSync(
        path.join(fixture, 'import-check.mjs'),
        [
          "import { runWorkflow, newWorkflow, FakeAgentRunner, serve, SqliteStateStore } from 'rijo';",
          "if (typeof runWorkflow !== 'function') { console.error('runWorkflow missing'); process.exit(1); }",
          "if (typeof newWorkflow !== 'function') { console.error('newWorkflow missing'); process.exit(1); }",
          "if (typeof serve !== 'function') { console.error('serve missing'); process.exit(1); }",
          "if (typeof FakeAgentRunner !== 'function') { console.error('FakeAgentRunner missing'); process.exit(1); }",
          "if (typeof SqliteStateStore !== 'function') { console.error('SqliteStateStore missing'); process.exit(1); }",
          "const store = new SqliteStateStore({ projectRoot: process.cwd() });",
          "await store.initialize();",
          "const integrity = await store.integrityCheck();",
          "if (!integrity.ok) { console.error(integrity.errors.join('; ')); process.exit(1); }",
          "await store.createBackup('.rijo/state/backups/pack-install.sqlite');",
          "await store.close();",
          "console.log('import-sqlite-backup-ok');",
        ].join('\n'),
      );
      const importOut = await run(process.execPath, ['import-check.mjs'], fixture);
      expect(importOut.trim()).toBe('import-sqlite-backup-ok');
      expect(fs.existsSync(path.join(fixture, '.rijo', 'state', 'backups', 'pack-install.sqlite'))).toBe(true);
    } finally {
      fs.rmSync(tarball, { force: true });
      cleanup(fixture);
    }
  }, 300000);
});
