import * as path from 'node:path';
import { ensureDir, exists, readTextIfExists, readJsonIfExists, writeFileAtomic, writeJsonAtomic } from '../core/fsx.js';
import { loadConfig } from '../core/config.js';
import { RijoPaths } from '../core/paths.js';
import type { ModelRole } from '../core/schemas/index.js';
import { claudeTierForRole, resolveClaudeTier } from '../agents/roles.js';
import { EXPERT_PROFILES } from '../experts/catalog.js';
import { renderProfileBrief } from '../experts/embed.js';
import { upsertMarkerFile, rijoInstructionBlock, loadSkillSource, type AdapterReport } from './shared.js';

const SKILLS = ['rijo-map', 'rijo-new', 'rijo-run', 'rijo-ui', 'rijo-fix', 'rijo-check'] as const;

/**
 * Specialized Claude Code agents. Each carries the RIJO `role` it fills so the
 * generated `.claude/agents/*.md` files can be stamped with the concrete model
 * tier resolved from `.rijo/config.yml` — routing is operational, not just
 * declarative (the same tier the orchestrator puts on each AgentTask).
 */
const AGENT_DEFS: Array<{ name: string; role: ModelRole; description: string; body: string }> = [
  {
    name: 'rijo-worker',
    role: 'worker',
    description: 'Economical implementation worker for one RIJO task with a strict write scope.',
    body: 'Implement exactly one RIJO task. Read only the files listed in your brief. Never write outside your declared write scope; if you need to, stop and request a new allocation. Follow TDD when the task says so (RED, GREEN, REFACTOR). Return a one-line summary plus the JSON payload the brief demands — never your private reasoning.',
  },
  {
    name: 'rijo-reviewer',
    role: 'reviewer',
    description: 'Independent reviewer: receives spec, diff and evidence, never the author reasoning.',
    body: 'Review the artifact against the spec and rules. Classify each finding as intent_gap, spec_gap, implementation_bug, test_gap, security_risk, quality_issue, defer or reject. Evidence beats claims: an agent summary is not evidence. Return the JSON verdict payload only.',
  },
  {
    name: 'rijo-researcher',
    role: 'researcher',
    description: 'Economical researcher: official sources only, claim+url+date for every volatile fact.',
    body: 'Research the given topic using official documentation, release/LTS pages, changelogs, advisories and registries. Never assume newest is best. Separate fact, inference and recommendation. Return the JSON payload with summary and sources (claim, source, url, checked_at, version, confidence).',
  },
  {
    name: 'rijo-qa',
    role: 'qa',
    description: 'Browser QA agent: executes one journey as a real user and reports structured results.',
    body: 'Execute the journey end-to-end as a real user. Observe console, network, error states, keyboard navigation. Capture screenshots into your write scope on failure. Return the JSON journey result payload only.',
  },
];

/**
 * Claude Code adapter: project skills, specialized agents, idempotent
 * CLAUDE.md block, statusline script. Never destroys an existing statusline.
 */
export function generateClaudeAdapter(projectRoot: string): AdapterReport {
  const report: AdapterReport = { generated: [], skipped: [], notes: [] };

  // skills
  for (const skill of SKILLS) {
    const source = loadSkillSource(skill);
    if (!source) {
      report.skipped.push(`skill ${skill} (source missing in package)`);
      continue;
    }
    const dir = path.join(projectRoot, '.claude', 'skills', skill);
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
    // `model` MUST be a concrete Claude model Claude Code accepts (alias
    // opus/sonnet/haiku/fable or a claude-* id) — never the abstract RIJO tier
    // string. Resolved from providers.claude for the role's tier; `tier` keeps
    // the routing traceable to the same value the orchestrator sets on each
    // AgentTask for role `${agent.role}`.
    const tier = config.models[agent.role];
    const resolved = claudeTierForRole(config, agent.role);
    writeFileAtomic(
      path.join(dir, `${agent.name}.md`),
      `---\nname: ${agent.name}\ndescription: ${agent.description}\nrole: ${agent.role}\ntier: ${tier}\nmodel: ${resolved.model}\n---\n\n${agent.body}\n`,
    );
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
  upsertMarkerFile(path.join(projectRoot, 'CLAUDE.md'), rijoInstructionBlock());
  report.generated.push('CLAUDE.md (RIJO block)');

  // statusline script (reads runtime/status.json; zero model calls)
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
