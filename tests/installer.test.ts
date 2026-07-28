import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { installRijo, prepareProjectBinding } from '../src/install/index.js';
import { cleanup, tmpProject } from './helpers.js';

describe('native installer API', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) cleanup(root);
  });

  it('installs both project providers without an initialized RIJO project', () => {
    const root = tmpProject('rijo-install-project-');
    roots.push(root);

    const report = installRijo({ root, hosts: ['codex', 'claude'], scope: 'project' });

    expect(report.hosts).toEqual(['claude', 'codex']);
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'rijo', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'rijo', 'references', 'phase-cycle.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude', 'agents', 'rijo-worker.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.rijo', 'config.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.rijo', 'bin', 'rijo.cjs'))).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.rijo,
    ).toBe('0.2.0-rc.1');
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('.rijo/runtime/');
    expect(ignore.match(/# RIJO:BEGIN/g)).toHaveLength(1);
    expect(report.binding?.managedPaths).toEqual(
      expect.arrayContaining([
        { path: 'package.json', created_by_rijo: true },
        { path: 'package-lock.json', created_by_rijo: true },
        { path: '.gitignore', created_by_rijo: true },
      ]),
    );
  });

  it('uses provider user locations and is byte-idempotent', () => {
    const root = tmpProject('rijo-install-user-');
    roots.push(root);

    installRijo({ root, hosts: ['codex', 'claude'], scope: 'user' });
    const tracked = [
      path.join(root, '.agents', 'skills', 'rijo', 'SKILL.md'),
      path.join(root, '.codex', 'AGENTS.md'),
      path.join(root, '.claude', 'skills', 'rijo', 'SKILL.md'),
      path.join(root, '.claude', 'CLAUDE.md'),
    ];
    const first = tracked.map((file) => fs.readFileSync(file, 'utf8'));

    installRijo({ root, hosts: ['claude', 'codex', 'claude'], scope: 'user' });
    const second = tracked.map((file) => fs.readFileSync(file, 'utf8'));

    expect(second).toEqual(first);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.rijo'))).toBe(false);
  });

  it('preserves manual provider instructions across repeated project installs', () => {
    const root = tmpProject('rijo-install-markers-');
    roots.push(root);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Manual rules\n\nKeep this text.\n', 'utf8');

    installRijo({ root, hosts: ['codex'], scope: 'project' });
    installRijo({ root, hosts: ['codex'], scope: 'project' });

    const instructions = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(instructions).toContain('# Manual rules');
    expect(instructions).toContain('Keep this text.');
    expect(instructions.match(/<!-- RIJO:BEGIN -->/g)).toHaveLength(1);
    expect(instructions.match(/<!-- RIJO:END -->/g)).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').match(/# RIJO:BEGIN/g))
      .toHaveLength(1);
  });

  it('does not claim pre-existing project tooling files', () => {
    const root = tmpProject('rijo-install-owned-files-');
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'user-project', private: true }, null, 2),
    );
    fs.writeFileSync(path.join(root, '.gitignore'), 'coverage/\n');

    const first = installRijo({ root, hosts: ['codex'], scope: 'project' });
    const second = installRijo({ root, hosts: ['codex'], scope: 'project' });

    for (const report of [first, second]) {
      expect(report.binding?.managedPaths).toEqual(
        expect.arrayContaining([
          { path: 'package.json', created_by_rijo: false },
          { path: '.gitignore', created_by_rijo: false },
          { path: 'package-lock.json', created_by_rijo: true },
        ]),
      );
    }
  });

  it('rejects a provider destination that escapes through a symbolic link', () => {
    if (process.platform === 'win32') return;
    const root = tmpProject('rijo-install-symlink-');
    const outside = tmpProject('rijo-install-outside-');
    roots.push(root, outside);
    fs.symlinkSync(outside, path.join(root, '.agents'), 'dir');

    expect(() => installRijo({ root, hosts: ['codex'], scope: 'project' })).toThrow(
      /symbolic link/i,
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('uses isolated npm tooling when the application uses another package manager', () => {
    const root = tmpProject('rijo-install-pnpm-');
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'pnpm-app', private: true }, null, 2),
    );
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const report = installRijo({ root, hosts: ['codex'], scope: 'project' });

    expect(report.binding?.isolated).toBe(true);
    expect(fs.existsSync(path.join(root, 'package-lock.json'))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(root, '.rijo', 'tooling', 'package.json'), 'utf8'),
      ).devDependencies.rijo,
    ).toBe('0.2.0-rc.1');
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).not.toContain('rijo');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'))
      .toContain('.rijo/tooling/node_modules/');
  });

  it('runs only the locked local CLI and blocks a divergent lock version', () => {
    const root = tmpProject('rijo-install-launcher-');
    roots.push(root);
    const binding = prepareProjectBinding(root);
    const installed = path.join(root, 'node_modules', 'rijo');
    fs.mkdirSync(path.join(installed, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(
      path.join(installed, 'package.json'),
      JSON.stringify({ name: 'rijo', version: binding.version, type: 'module' }),
    );
    fs.writeFileSync(
      path.join(installed, 'dist', 'cli', 'index.js'),
      "console.log(JSON.stringify({ marker: 'LOCAL_RIJO', cwd: process.cwd(), args: process.argv.slice(2) }));\n",
    );
    const lock = {
      name: path.basename(root),
      version: '0.0.0',
      lockfileVersion: 3,
      packages: {
        '': { devDependencies: { rijo: binding.version } },
        'node_modules/rijo': { version: binding.version, dev: true },
      },
    };
    fs.writeFileSync(binding.lockfile, JSON.stringify(lock, null, 2));

    const nestedCwd = path.join(root, '.rijo', 'runtime');
    fs.mkdirSync(nestedCwd, { recursive: true });
    const local = spawnSync(process.execPath, [binding.launcher, 'internal', 'status'], {
      cwd: nestedCwd,
      encoding: 'utf8',
    });
    expect(local.status).toBe(0);
    expect(JSON.parse(local.stdout)).toEqual({
      marker: 'LOCAL_RIJO',
      cwd: fs.realpathSync(root),
      args: ['internal', 'status'],
    });

    lock.packages['node_modules/rijo'].version = '9.9.9';
    fs.writeFileSync(binding.lockfile, JSON.stringify(lock, null, 2));
    const divergent = spawnSync(process.execPath, [binding.launcher, 'status'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(divergent.status).toBe(1);
    expect(divergent.stderr).toContain('project binding mismatch');
  });
});
