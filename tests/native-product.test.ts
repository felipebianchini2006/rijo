import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAdapters } from '../src/adapters/index.js';
import { runCli } from '../src/cli/main.js';
import { cleanup, deps, tmpProject, writePlanFile } from './helpers.js';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const supportedCommands = [
  'map-codebase',
  'new',
  'ui',
  'start',
  'test',
  'fix',
  'finish',
  'next',
  'status',
  'resume',
];

describe('native RIJO product surface', () => {
  let root: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = tmpProject('rijo-native-');
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    cleanup(root);
  });

  it('ships one canonical public skill with progressive command routing', () => {
    const skillRoot = path.join(repositoryRoot, 'skills', 'rijo');
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');

    expect(skill.length).toBeLessThan(5_000);
    expect(skill).toContain('references/command-router.md');
    for (const command of supportedCommands) {
      expect(skill).toContain(command);
      expect(fs.existsSync(path.join(skillRoot, 'references', `${command}.md`))).toBe(true);
    }
    for (const reference of [
      'command-router',
      'phase-cycle',
      'decision-policy',
      'engineering-review',
      'language-style',
    ]) {
      expect(fs.existsSync(path.join(skillRoot, 'references', `${reference}.md`))).toBe(true);
    }
    expect(skill).not.toContain('codex exec');
    expect(skill).not.toContain('claude -p');
    expect(skill).not.toContain('--host');
    expect(skill).not.toContain('--run');

    const nativeResults = fs.readFileSync(
      path.join(skillRoot, 'references', 'native-results.md'),
      'utf8',
    );
    for (const field of ['task_id', 'ok', 'summary', 'payload', 'files', 'scope_requests']) {
      expect(nativeResults).toContain(`"${field}"`);
    }
    expect(nativeResults).toContain('Put the structured return value in `payload`.');
    expect(nativeResults).toContain('Do not encode the payload in `summary`.');
    expect(nativeResults).toContain('Do not invoke Python, Go, or Rust.');
  });

  it('keeps old skills as short compatibility redirects', () => {
    for (const alias of ['rijo-map', 'rijo-new', 'rijo-run', 'rijo-ui', 'rijo-fix', 'rijo-check']) {
      const source = fs.readFileSync(path.join(repositoryRoot, 'skills', `${alias}.md`), 'utf8');
      expect(source).toContain('canonical `rijo` skill');
      expect(source.length).toBeLessThan(1_500);
    }
  });

  it('installs the canonical skill and the provider instruction blocks', () => {
    const codex = generateAdapters(root, ['codex']);
    const claude = generateAdapters(root, ['claude']);

    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'rijo', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'rijo', 'references', 'start.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'rijo', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'rijo', 'references', 'start.md'))).toBe(true);
    expect(codex.generated).toContain('.agents/skills/rijo/SKILL.md');
    expect(claude.generated).toContain('.claude/skills/rijo/SKILL.md');

    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const claudeInstructions = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    for (const text of [agents, claudeInstructions]) {
      expect(text).toContain('RIJO project memory is in `.rijo/`');
      expect(text).toContain('Read `.rijo/STATE.md` first when it exists');
      expect(text).toContain('native subagents');
      expect(text).toContain('Do not run `codex exec`');
      expect(text).toContain('Do not claim completion without evidence');
    }
  });

  it('generates all required Claude agents with native control fields', () => {
    generateAdapters(root, ['claude']);
    const agents = [
      'rijo-project-researcher',
      'rijo-phase-planner',
      'rijo-plan-reviewer',
      'rijo-worker',
      'rijo-code-reviewer',
      'rijo-test-engineer',
      'rijo-security-reviewer',
      'rijo-browser-qa',
      'rijo-mobile-qa',
    ];
    for (const agent of agents) {
      const source = fs.readFileSync(path.join(root, '.claude', 'agents', `${agent}.md`), 'utf8');
      expect(source).toMatch(/^model:/m);
      expect(source).toMatch(/^effort:/m);
      expect(source).toMatch(/^maxTurns:/m);
      expect(source).toMatch(/^skills:/m);
      expect(source).toMatch(/^hooks:/m);
      if (agent === 'rijo-worker') {
        expect(source).toMatch(/^isolation: worktree$/m);
        expect(source).toContain(
          'Do not write to `.rijo/runtime/workspaces/` from the host worktree.',
        );
        expect(source).toContain(
          'read the project-root copy as read-only context',
        );
      }
      if (agent === 'rijo-code-reviewer') {
        expect(source).toContain(
          'RIJO runs the framework-owned UI smoke after this review.',
        );
        expect(source).toContain(
          'Do not reject the phase only because UI smoke evidence does not exist yet.',
        );
      }
      if (agent === 'rijo-browser-qa' || agent === 'rijo-mobile-qa') {
        expect(source).toContain('ToolSearch');
        expect(source).toContain('Load the available');
      }
      expect(source).not.toContain('command: "rijo internal lifecycle');
      expect(source).toContain('native-hooks.jsonl');
    }
  });

  it('uses native-first help and routes the new public command names', async () => {
    expect(await runCli(['--help'], {}, root)).toBe(0);
    const help = log.mock.calls.flat().join('\n');
    expect(help).toContain('Use `$rijo` in Codex or `/rijo` in Claude Code.');
    expect(help).toContain('start');
    expect(help).toContain('test');
    expect(help).toContain('finish');
    expect(help).toContain('next');
    expect(help).toContain('resume');
    expect(help.indexOf('Advanced')).toBeGreaterThan(help.indexOf('Use `$rijo`'));

    log.mockClear();
    expect(await runCli(['status', '--json'], {}, root)).toBe(0);
    expect(JSON.parse(log.mock.calls.flat().join('')).initialized).toBe(false);
    expect(await runCli(['map-codebase', '--status'], deps(root), root)).toBe(1);
  });

  it('prints deprecation notices for the old run and check aliases', async () => {
    expect(await runCli(['run'], deps(root), root)).not.toBe(2);
    expect(error.mock.calls.flat().join('\n')).toContain('deprecated');

    error.mockClear();
    expect(await runCli(['check'], deps(root), root)).not.toBe(2);
    expect(error.mock.calls.flat().join('\n')).toContain('deprecated');
  });

  it('does not start a host process for native public routing', async () => {
    writePlanFile(root, 'PLAN.md', '# Plan\n\nCreate one file.\n');
    const source = fs.readFileSync(path.join(repositoryRoot, 'src', 'cli', 'main.ts'), 'utf8');
    const nativeCases = source.slice(source.indexOf("case 'map-codebase'"), source.indexOf("case 'serve'"));
    expect(nativeCases).not.toContain('buildHostExecutor');
    expect(nativeCases).not.toContain('resolveHostProvider');
    expect(nativeCases).not.toContain('codex exec');
    expect(nativeCases).not.toContain('claude -p');
  });
});
