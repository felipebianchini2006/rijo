import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAdapters } from '../src/adapters/index.js';
import { upsertMarkerBlock, BEGIN, END, packageRoot } from '../src/adapters/shared.js';
import { cleanup, tmpProject } from './helpers.js';

describe('upsertMarkerBlock', () => {
  it('inserts the block into an empty file', () => {
    const out = upsertMarkerBlock(null, 'line one\nline two');
    expect(out).toBe(`${BEGIN}\nline one\nline two\n${END}\n`);
    // empty string behaves the same as a missing file
    expect(upsertMarkerBlock('', 'body')).toBe(`${BEGIN}\nbody\n${END}\n`);
  });

  it('preserves manual content outside the markers when the block is regenerated', () => {
    const manualTop = '# My manual notes\n\nkeep me\n\n';
    const manualBottom = '\n\n## Appendix\nalso keep me\n';
    const v1 = manualTop + `${BEGIN}\nold body\n${END}` + manualBottom;
    const v2 = upsertMarkerBlock(v1, 'new body v2');
    expect(v2.startsWith(manualTop)).toBe(true);
    expect(v2.endsWith(manualBottom)).toBe(true);
    expect(v2).toContain('new body v2');
    expect(v2).not.toContain('old body');
  });

  it('is idempotent: applying the same body twice equals once', () => {
    const once = upsertMarkerBlock('# Header\n', 'stable body');
    const twice = upsertMarkerBlock(once, 'stable body');
    expect(twice).toBe(once);
  });

  it('appends the block when a file exists without markers', () => {
    const out = upsertMarkerBlock('# Existing file\n', 'body');
    expect(out.startsWith('# Existing file')).toBe(true);
    expect(out).toContain(`${BEGIN}\nbody\n${END}`);
  });
});

describe('generateAdapters', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject('rijo-adapters-');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup(root);
  });

  it('packageRoot() resolves to the package root with skills/ when running from source', () => {
    expect(fs.existsSync(path.join(packageRoot(), 'skills', 'rijo-new.md'))).toBe(true);
  });

  it("['claude'] creates skills, agents, CLAUDE.md block, statusline script and settings.json", () => {
    const report = generateAdapters(root, ['claude']);

    for (const skill of ['rijo-map', 'rijo-new', 'rijo-run', 'rijo-ui', 'rijo-fix', 'rijo-check']) {
      expect(fs.existsSync(path.join(root, '.claude', 'skills', skill, 'SKILL.md'))).toBe(true);
    }
    const workerAgentPath = path.join(root, '.claude', 'agents', 'rijo-worker.md');
    expect(fs.existsSync(workerAgentPath)).toBe(true);

    // The `model` field MUST be a concrete Claude model Claude Code accepts —
    // never the abstract RIJO tier string. rijo-worker maps to role `worker`,
    // tier `economical-coding`, which resolves to the `fable` alias.
    const workerAgent = fs.readFileSync(workerAgentPath, 'utf8');
    const modelLine = workerAgent.match(/^model:\s*(.+)$/m)?.[1]?.trim();
    expect(modelLine, workerAgent).toBeDefined();
    expect(['opus', 'sonnet', 'haiku', 'fable']).toContain(modelLine!);
    // the abstract tier must NOT leak into the model field
    expect(modelLine).not.toBe('economical-coding');
    expect(modelLine).not.toMatch(/^(strongest|balanced|economical)/);
    // routing stays traceable via a separate tier line
    expect(workerAgent).toMatch(/^tier:\s*economical-coding$/m);

    const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(BEGIN);
    expect(claudeMd).toContain(END);
    expect(claudeMd).toContain('.rijo/STATE.md');

    expect(fs.existsSync(path.join(root, '.rijo', 'adapters', 'claude', 'statusline.cjs'))).toBe(true);

    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    expect(settings.statusLine).toMatchObject({
      type: 'command',
      command: 'node .rijo/adapters/claude/statusline.cjs',
    });
    expect(report.generated).toContain('.claude/skills/rijo-new/SKILL.md');
    expect(report.generated).toContain('.rijo/adapters/claude/statusline.cjs');
  });

  it('never overwrites a pre-existing foreign statusLine; writes STATUSLINE.md instead', () => {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = {
      statusLine: { type: 'command', command: 'node my-own-statusline.js' },
      permissions: { allow: ['Bash(npm test)'] },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf8');

    const report = generateAdapters(root, ['claude']);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.statusLine).toEqual(original.statusLine);
    expect(after.permissions).toEqual(original.permissions);

    const instructions = path.join(root, '.rijo', 'adapters', 'claude', 'STATUSLINE.md');
    expect(fs.existsSync(instructions)).toBe(true);
    const md = fs.readFileSync(instructions, 'utf8');
    expect(md).toContain('did not overwrite');
    expect(md).toContain('statusline.cjs');
    expect(report.skipped.some((s) => s.includes('statusLine'))).toBe(true);
  });

  it('adds statusLine to an existing settings.json without one, preserving other keys', () => {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { allow: ['Read'] }, env: { FOO: 'bar' } }, null, 2),
      'utf8',
    );

    generateAdapters(root, ['claude']);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.permissions).toEqual({ allow: ['Read'] });
    expect(after.env).toEqual({ FOO: 'bar' });
    expect(after.statusLine).toMatchObject({
      type: 'command',
      command: 'node .rijo/adapters/claude/statusline.cjs',
    });
  });

  it("['codex'] creates .agents skills and AGENTS.md with transition-marker instructions", () => {
    generateAdapters(root, ['codex']);

    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'rijo-map', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'rijo-run', 'SKILL.md'))).toBe(true);
    const agentsMd = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    expect(agentsMd).toContain(BEGIN);
    expect(agentsMd).toContain('The Codex project skill is at `.agents/skills/rijo/SKILL.md`.');
    expect(agentsMd).toContain('Do not search outside the active project skill directory');
    expect(agentsMd).toContain('[RIJO M002 F03/05] EXECUTE T02/04');
    expect(agentsMd).toContain('`fork_turns` to `none`');
    expect(agentsMd).toContain('Omit `agent_type`');
    expect(agentsMd).toContain('Publish one short transition message');
  });

  it('with no detection generates only the generic AGENTS.md block', () => {
    // running under Claude Code sets CLAUDECODE=1, which would trip detection
    vi.stubEnv('CLAUDECODE', '');

    const report = generateAdapters(root);

    expect(report.generated).toEqual(['AGENTS.md (RIJO block)']);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.agents'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'CLAUDE.md'))).toBe(false);
  });

  it('manual content in CLAUDE.md survives adapter regeneration', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# My custom notes\n\nDo not lose this.\n', 'utf8');

    generateAdapters(root, ['claude']);
    generateAdapters(root, ['claude']); // regenerate

    const claudeMd = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('# My custom notes');
    expect(claudeMd).toContain('Do not lose this.');
    // exactly one RIJO block
    expect(claudeMd.split(BEGIN).length - 1).toBe(1);
    expect(claudeMd.split(END).length - 1).toBe(1);
  });

  it('statusline script renders the runtime status line from status.json', () => {
    generateAdapters(root, ['claude']);

    const runtimeDir = path.join(root, '.rijo', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, 'status.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: 'run-1',
        status: 'running',
        milestone: { id: 'M002', name: 'x' },
        phase: { id: '03', index: 3, total: 5, name: 'y' },
        stage: 'EXECUTE',
        task: { id: 'T02', index: 2, total: 4, name: 'z' },
        agent: null,
        completed_units: 0,
        total_units: 0,
        last_checkpoint: null,
        started_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        message: 'hello',
      }),
      'utf8',
    );

    const stdout = execFileSync(process.execPath, ['.rijo/adapters/claude/statusline.cjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(stdout.trim()).toBe('[RIJO M002 F03/05] EXECUTE T02/04  hello');
  });

  it('statusline script prints idle when no status.json exists', () => {
    generateAdapters(root, ['claude']);
    const stdout = execFileSync(process.execPath, ['.rijo/adapters/claude/statusline.cjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(stdout.trim()).toBe('[RIJO] idle');
  });
});
