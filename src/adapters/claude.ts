import * as path from 'node:path';
import { ensureDir, exists, readTextIfExists, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../core/fsx.js';
import { loadConfig } from '../core/config.js';
import { RijoPaths } from '../core/paths.js';
import type { ModelRole } from '../core/schemas/index.js';
import { claudeTierForRole, resolveClaudeTier } from '../agents/roles.js';
import { EXPERT_PROFILES } from '../experts/catalog.js';
import { renderProfileBrief } from '../experts/embed.js';
import {
  installCanonicalSkill,
  loadSkillSource,
  rijoInstructionBlock,
  assertProviderDestinationsSafe,
  upsertMarkerFile,
  type AdapterReport,
} from './shared.js';

const LEGACY_SKILLS = ['rijo-map', 'rijo-new', 'rijo-run', 'rijo-ui', 'rijo-fix', 'rijo-check'] as const;

export interface ClaudeAdapterOptions {
  scope?: 'project' | 'user';
}

/**
 * Specialized Claude Code agents. Each carries the RIJO `role` it fills so the
 * generated `.claude/agents/*.md` files can be stamped with the concrete model
 * tier resolved from `.rijo/config.yml` — routing is operational, not just
 * declarative (the same tier the orchestrator puts on each AgentTask).
 */
interface NativeClaudeAgent {
  name: string;
  role: ModelRole;
  description: string;
  body: string;
  effort: 'low' | 'medium' | 'high';
  maxTurns: number;
  tools: string[];
  readOnly?: boolean;
  isolation?: 'worktree';
}

const AGENT_DEFS: NativeClaudeAgent[] = [
  {
    name: 'rijo-project-researcher',
    role: 'researcher',
    description: 'Research stable project decisions from official sources before RIJO creates a roadmap.',
    body: 'Research only the assigned project questions. Use official sources for volatile facts. Separate facts, inferences, and recommendations. Return each claim with its source URL, checked date, version, and confidence. Do not change files.',
    effort: 'medium',
    maxTurns: 18,
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    readOnly: true,
  },
  {
    name: 'rijo-phase-planner',
    role: 'researcher',
    description: 'Research one active phase and produce a bounded RIJO phase plan.',
    body: 'Read only the active phase context. Research only the phase delta. Produce two to four bounded tasks. Define requirement identifiers, files, write scopes, dependencies, acceptance criteria, tests, evidence, Test-Driven Development requirements, and parallel safety. Return the plan to the lead. Do not change files.',
    effort: 'high',
    maxTurns: 20,
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    readOnly: true,
  },
  {
    name: 'rijo-plan-reviewer',
    role: 'reviewer',
    description: 'Review one RIJO phase plan independently before implementation.',
    body: 'Review the phase goal, research, plan, codebase context, and rules. Do not use planner reasoning. Find missing scope, unsafe dependencies, weak evidence, and non-testable acceptance criteria. Return an approve or revise verdict with actionable findings. Do not change files.',
    effort: 'high',
    maxTurns: 12,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
  },
  {
    name: 'rijo-worker',
    role: 'worker',
    description: 'Implement one bounded RIJO task in an isolated worktree.',
    body: 'Implement exactly one RIJO task. Stay inside the declared write scope. Use Test-Driven Development for testable behavior. Run the listed verification commands. Return changed paths, command evidence, and blockers. Do not include private reasoning.',
    effort: 'medium',
    maxTurns: 30,
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
    isolation: 'worktree',
  },
  {
    name: 'rijo-code-reviewer',
    role: 'reviewer',
    description: 'Review verified RIJO changes independently for engineering quality.',
    body: 'Review the specification, plan, diff, and command evidence. Check correctness, simplicity, cohesion, coupling, duplication, error handling, security, data integrity, performance, test quality, code smells, unnecessary abstractions, and scope drift. Return a verdict and evidence. Do not change files.',
    effort: 'high',
    maxTurns: 16,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
  },
  {
    name: 'rijo-test-engineer',
    role: 'qa',
    description: 'Review deterministic verification evidence for one RIJO phase.',
    body: 'Inspect the recorded build, lint, type check, unit, integration, and contract evidence. Do not run direct shell commands. Do not accept agent statements as evidence. Return gaps and a verdict. Do not change project files.',
    effort: 'medium',
    maxTurns: 18,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
  },
  {
    name: 'rijo-security-reviewer',
    role: 'reviewer',
    description: 'Review one RIJO change for security and data integrity risks.',
    body: 'Inspect the assigned change and its trust boundaries. Check authorization, validation, secrets, injection, dependency, file, archive, process, and data-loss risks. Return only evidence-backed findings. Do not change files.',
    effort: 'high',
    maxTurns: 14,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
  },
  {
    name: 'rijo-browser-qa',
    role: 'qa',
    description: 'Run one requirement-derived web journey with available browser tools.',
    body: 'Run the assigned journey as a real user. Use real controls. Check persistence, authorization, console errors, network errors, keyboard access, responsive layouts, and all main interface states. Return READY, NOT_READY, or BLOCKED with evidence.',
    effort: 'medium',
    maxTurns: 24,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
  },
  {
    name: 'rijo-mobile-qa',
    role: 'qa',
    description: 'Run one requirement-derived mobile journey with an available simulator or emulator.',
    body: 'Build and install the application. Run the assigned journey on a real simulator or emulator. Capture screenshots and logs for each defect. Return READY, NOT_READY, or BLOCKED with evidence.',
    effort: 'medium',
    maxTurns: 24,
    tools: ['Read', 'Glob', 'Grep'],
    readOnly: true,
  },
];

/**
 * Claude Code adapter: project skills, specialized agents, idempotent
 * CLAUDE.md block, statusline script. Never destroys an existing statusline.
 */
export function generateClaudeAdapter(projectRoot: string, options: ClaudeAdapterOptions = {}): AdapterReport {
  const report: AdapterReport = { generated: [], skipped: [], notes: [] };
  const scope = options.scope ?? 'project';
  const skillsRoot = path.join(projectRoot, '.claude', 'skills');
  const instructionFile =
    scope === 'user' ? path.join(projectRoot, '.claude', 'CLAUDE.md') : path.join(projectRoot, 'CLAUDE.md');
  assertProviderDestinationsSafe(projectRoot, [
    path.join(projectRoot, '.claude'),
    path.join(projectRoot, '.claude', 'skills'),
    path.join(projectRoot, '.claude', 'agents'),
    instructionFile,
  ]);

  for (const file of installCanonicalSkill(path.join(skillsRoot, 'rijo'))) {
    report.generated.push(relativeReportPath(projectRoot, file));
  }

  // Install one-release compatibility aliases. Each alias redirects to `rijo`.
  for (const skill of LEGACY_SKILLS) {
    const source = loadSkillSource(skill);
    if (!source) {
      report.skipped.push(`skill ${skill} (source missing in package)`);
      continue;
    }
    const dir = path.join(skillsRoot, skill);
    ensureDir(dir);
    writeFileAtomic(path.join(dir, 'SKILL.md'), source);
    report.generated.push(`.claude/skills/${skill}/SKILL.md`);
  }

  // specialized agents — stamped with the model tier of their RIJO role so the
  // generated files carry operational routing (tier from .rijo/config.yml).
  const config = loadConfig(new RijoPaths(projectRoot));
  for (const agent of AGENT_DEFS) {
    const dir = path.join(projectRoot, '.claude', 'agents');
    ensureDir(dir);
    const tier = config.models[agent.role];
    const resolved = claudeTierForRole(config, agent.role);
    writeFileAtomic(path.join(dir, `${agent.name}.md`), renderNativeClaudeAgent(agent, tier, resolved.model));
    report.generated.push(`.claude/agents/${agent.name}.md`);
  }

  // expert profiles — .claude/agents/rijo-expert-<id>.md, one file per
  // catalog entry, generated from the SAME source as router.ts/embed.ts
  // (src/experts/catalog.ts). Writers (task-scope) map to the economical
  // coding tier and get edit access; advisors (none) map to the strongest
  // independent tier and stay read-only.
  const agentsDir = path.join(projectRoot, '.claude', 'agents');
  ensureDir(agentsDir);
  for (const profile of EXPERT_PROFILES) {
    const isWriter = profile.default_write_policy === 'task-scope';
    const tierName = isWriter ? 'economical-coding' : 'strongest-independent';
    const resolvedRole: ModelRole = isWriter ? 'worker' : 'reviewer';
    const resolved = resolveClaudeTier(config, tierName, resolvedRole);
    const maxTurns = isWriter ? 30 : 10;
    const permissionMode = isWriter ? 'acceptEdits' : 'plan';
    const disallowedTools = isWriter
      ? profile.denied_tools
      : Array.from(new Set([...profile.denied_tools, 'Write', 'Edit', 'Bash']));
    const body = renderProfileBrief([profile.id]);
    const frontmatter = [
      '---',
      `name: rijo-expert-${profile.id}`,
      `description: ${JSON.stringify(profile.mission)}`,
      `expert_profile: ${profile.id}`,
      `tier: ${tierName}`,
      `model: ${resolved.model}`,
      `maxTurns: ${maxTurns}`,
      `tools: [${profile.default_tools.join(', ')}]`,
      `disallowedTools: [${disallowedTools.join(', ')}]`,
      `permissionMode: ${permissionMode}`,
      '---',
      '',
    ].join('\n');
    writeFileAtomic(path.join(agentsDir, `rijo-expert-${profile.id}.md`), `${frontmatter}${body}\n`);
    report.generated.push(`.claude/agents/rijo-expert-${profile.id}.md`);
  }

  // CLAUDE.md idempotent block
  upsertMarkerFile(instructionFile, rijoInstructionBlock());
  report.generated.push(`${relativeReportPath(projectRoot, instructionFile)} (RIJO block)`);

  // statusline script (reads runtime/status.json; zero model calls)
  if (scope === 'user') return report;
  const adapterDir = path.join(projectRoot, '.rijo', 'adapters', 'claude');
  ensureDir(adapterDir);
  const scriptPath = path.join(adapterDir, 'statusline.cjs');
  writeFileAtomic(scriptPath, STATUSLINE_SCRIPT);
  report.generated.push('.rijo/adapters/claude/statusline.cjs');

  // settings: only set statusLine when it can be done without destroying config
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  const settings = readJsonIfExists<Record<string, unknown>>(settingsPath);
  const command = 'node .rijo/adapters/claude/statusline.cjs';
  if (!settings) {
    ensureDir(path.dirname(settingsPath));
    writeJsonAtomic(settingsPath, { statusLine: { type: 'command', command, refreshInterval: 1000 } });
    report.generated.push('.claude/settings.json (statusLine)');
  } else if (!settings['statusLine']) {
    writeJsonAtomic(settingsPath, { ...settings, statusLine: { type: 'command', command, refreshInterval: 1000 } });
    report.generated.push('.claude/settings.json (statusLine added, existing keys preserved)');
  } else {
    const existing = JSON.stringify(settings['statusLine']);
    if (existing.includes('statusline.cjs')) {
      report.skipped.push('statusLine (already RIJO)');
    } else {
      writeFileAtomic(
        path.join(adapterDir, 'STATUSLINE.md'),
        [
          '# Composing the RIJO status line',
          '',
          'An existing statusLine was found in `.claude/settings.json`; RIJO did not overwrite it.',
          'To compose both, chain the commands in your existing script or wrap them:',
          '',
          '```json',
          `{ "statusLine": { "type": "command", "command": "<your-script> && ${command}", "refreshInterval": 1000 } }`,
          '```',
          '',
          'The RIJO segment prints: `[RIJO M002 F03/05] EXECUTE T02/04  message`.',
          'Progress updates keep flowing in chat and in `.rijo/runtime/status.json` regardless.',
        ].join('\n'),
      );
      report.skipped.push('statusLine (existing preserved; see .rijo/adapters/claude/STATUSLINE.md)');
      report.notes.push('Existing statusLine preserved; composition instructions generated.');
    }
  }
  return report;
}

export function detectClaude(projectRoot: string): boolean {
  // filesystem-based only: deterministic across environments
  return exists(path.join(projectRoot, '.claude')) || readTextIfExists(path.join(projectRoot, 'CLAUDE.md')) !== null;
}

function renderNativeClaudeAgent(agent: NativeClaudeAgent, tier: string, model: string): string {
  const frontmatter = [
    '---',
    `name: ${agent.name}`,
    `description: ${JSON.stringify(agent.description)}`,
    `role: ${agent.role}`,
    `tier: ${tier}`,
    `model: ${model}`,
    `effort: ${agent.effort}`,
    `maxTurns: ${agent.maxTurns}`,
    'skills: [rijo]',
    `tools: [${agent.tools.join(', ')}]`,
    `permissionMode: ${agent.readOnly ? 'plan' : 'acceptEdits'}`,
  ];
  if (agent.readOnly) frontmatter.push('disallowedTools: [Write, Edit, NotebookEdit, Bash]');
  if (agent.isolation) frontmatter.push(`isolation: ${agent.isolation}`);
  frontmatter.push(
    'hooks:',
    ...renderLifecycleHook('SubagentStart'),
    ...renderLifecycleHook('Stop'),
    ...renderLifecycleHook('StopFailure'),
    ...renderLifecycleHook('WorktreeRemove'),
    '---',
    '',
  );
  return `${frontmatter.join('\n')}${agent.body}\n`;
}

function renderLifecycleHook(event: string): string[] {
  return [
    `  ${event}:`,
    '    - hooks:',
    '        - type: command',
    `          command: ${JSON.stringify(`rijo internal lifecycle ${event}`)}`,
  ];
}

function relativeReportPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

const STATUSLINE_SCRIPT = `#!/usr/bin/env node
// RIJO status line for Claude Code. Reads .rijo/runtime/status.json only —
// no model calls, no network. Prints one short line.
'use strict';
const fs = require('fs');
const path = require('path');
function findStatus(dir) {
  for (let i = 0; i < 10; i++) {
    const p = path.join(dir, '.rijo', 'runtime', 'status.json');
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
try {
  const p = findStatus(process.cwd());
  if (!p) { console.log('[RIJO] idle'); process.exit(0); }
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  const parts = ['[RIJO'];
  if (s.milestone) parts.push(s.milestone.id);
  if (s.phase) parts.push('F' + s.phase.id + '/' + String(s.phase.total).padStart(2, '0'));
  let line = parts.join(' ') + ']';
  if (s.stage) line += ' ' + s.stage;
  if (s.task) line += ' T' + String(s.task.id).replace(/^T/, '') + '/' + String(s.task.total).padStart(2, '0');
  if (s.message) line += '  ' + s.message;
  console.log(line);
} catch (e) {
  console.log('[RIJO] status unavailable');
}
`;
