import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installRijo } from '../src/install/index.js';
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
});
