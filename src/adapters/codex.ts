import * as path from 'node:path';
import { ensureDir, exists, writeFileAtomic } from '../core/fsx.js';
import { loadConfig } from '../core/config.js';
import { RijoPaths } from '../core/paths.js';
import type { ModelRole } from '../core/schemas/index.js';
import { resolveCodexTier } from '../agents/roles.js';
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

export interface CodexAdapterOptions {
  scope?: 'project' | 'user';
}

/**
 * Codex adapter: repository skills in .agents/skills/, idempotent AGENTS.md
 * block, chat transition markers. Works with or without the Codex App Server;
 * without it, progress flows through chat messages, stdout and
 * .rijo/runtime/status.json — never pretending a native integration was used.
 */
export function generateCodexAdapter(projectRoot: string, options: CodexAdapterOptions = {}): AdapterReport {
  const report: AdapterReport = { generated: [], skipped: [], notes: [] };
  const scope = options.scope ?? 'project';
  const skillsRoot = path.join(projectRoot, '.agents', 'skills');
  const instructionFile =
    scope === 'user' ? path.join(projectRoot, '.codex', 'AGENTS.md') : path.join(projectRoot, 'AGENTS.md');
  assertProviderDestinationsSafe(projectRoot, [
    path.join(projectRoot, '.agents'),
    path.join(projectRoot, '.agents', 'skills'),
    path.join(projectRoot, '.agents', 'experts'),
    instructionFile,
  ]);

  for (const file of installCanonicalSkill(path.join(skillsRoot, 'rijo'))) {
    report.generated.push(relativeReportPath(projectRoot, file));
  }

  // Keep the one-release aliases small. The canonical tree owns all behavior.
  for (const skill of LEGACY_SKILLS) {
    const source = loadSkillSource(skill);
    if (!source) {
      report.skipped.push(`skill ${skill} (source missing in package)`);
      continue;
    }
    const dir = path.join(skillsRoot, skill);
    ensureDir(dir);
    writeFileAtomic(path.join(dir, 'SKILL.md'), source);
    report.generated.push(`.agents/skills/${skill}/SKILL.md`);
  }

  // expert profiles — .agents/experts/<id>.toml, one file per catalog entry,
  // generated from the SAME source as router.ts/embed.ts/claude.ts
  // (src/experts/catalog.ts). TOML is the chosen format for Codex expert
  // definitions (documented in docs/expert-profiles.md).
  const config = loadConfig(new RijoPaths(projectRoot));
  const expertsDir = path.join(projectRoot, '.agents', 'experts');
  ensureDir(expertsDir);
  for (const profile of EXPERT_PROFILES) {
    const isWriter = profile.default_write_policy === 'task-scope';
    const tierName = isWriter ? 'economical-coding' : 'strongest-independent';
    const resolvedRole: ModelRole = isWriter ? 'worker' : 'reviewer';
    const resolved = resolveCodexTier(config, tierName, resolvedRole);
    const sandbox = isWriter ? 'workspace-write' : 'read-only';
    const body = renderProfileBrief([profile.id]);
    const toml = [
      `name = "rijo-expert-${profile.id}"`,
      `description = ${JSON.stringify(profile.mission)}`,
      `expert_profile = "${profile.id}"`,
      `tier = "${tierName}"`,
      `model = "${resolved.model}"`,
      `reasoning_effort = "${resolved.reasoning_effort}"`,
      `sandbox = "${sandbox}"`,
      `write_policy = "${profile.default_write_policy}"`,
      '',
      "body = '''",
      body,
      "'''",
      '',
    ].join('\n');
    writeFileAtomic(path.join(expertsDir, `${profile.id}.toml`), toml);
    report.generated.push(`.agents/experts/${profile.id}.toml`);
  }

  const codexNotes = [
    rijoInstructionBlock(),
    '',
    '## Codex progress',
    '',
    '- Publish one short transition message for each RIJO stage change.',
    '- Use this format: `[RIJO M002 F03/05] EXECUTE T02/04  Integrate the payment gateway.`',
    '- Keep each native subagent bounded and inspectable.',
    '- Record a recoverable lease when the host cannot stop a failed subagent.',
  ].join('\n');
  upsertMarkerFile(instructionFile, codexNotes);
  report.generated.push(`${relativeReportPath(projectRoot, instructionFile)} (RIJO block)`);
  return report;
}

export function detectCodex(projectRoot: string): boolean {
  return exists(path.join(projectRoot, '.agents')) || exists(path.join(projectRoot, '.codex'));
}

function relativeReportPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
