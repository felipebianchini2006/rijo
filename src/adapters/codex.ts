import * as path from 'node:path';
import { ensureDir, exists, writeFileAtomic } from '../core/fsx.js';
import { upsertMarkerFile, rijoInstructionBlock, loadSkillSource, type AdapterReport } from './shared.js';

const SKILLS = ['rijo-new', 'rijo-run', 'rijo-ui', 'rijo-fix', 'rijo-check'] as const;

/**
 * Codex adapter: repository skills in .agents/skills/, idempotent AGENTS.md
 * block, chat transition markers. Works with or without the Codex App Server;
 * without it, progress flows through chat messages, stdout and
 * .rijo/runtime/status.json — never pretending a native integration was used.
 */
export function generateCodexAdapter(projectRoot: string): AdapterReport {
  const report: AdapterReport = { generated: [], skipped: [], notes: [] };

  for (const skill of SKILLS) {
    const source = loadSkillSource(skill);
    if (!source) {
      report.skipped.push(`skill ${skill} (source missing in package)`);
      continue;
    }
    const dir = path.join(projectRoot, '.agents', 'skills', skill);
    ensureDir(dir);
    writeFileAtomic(path.join(dir, 'SKILL.md'), source);
    report.generated.push(`.agents/skills/${skill}/SKILL.md`);
  }

  const codexNotes = [
    rijoInstructionBlock(),
    '',
    'Progresso observável (Codex):',
    '- Publique marcadores curtos de transição no chat: `[RIJO M002 F03/05] EXECUTE T02/04  mensagem`.',
    '- Use subagentes e threads nativos quando disponíveis; mantenha-os inspecionáveis.',
    '- Com App Server disponível, aproveite streaming de itens e tool progress; sem ele, use chat, stdout e `.rijo/runtime/status.json`.',
    '- Nunca afirme que uma integração nativa foi usada quando não estava disponível.',
  ].join('\n');
  upsertMarkerFile(path.join(projectRoot, 'AGENTS.md'), codexNotes);
  report.generated.push('AGENTS.md (RIJO block)');
  return report;
}

export function detectCodex(projectRoot: string): boolean {
  return exists(path.join(projectRoot, '.agents')) || exists(path.join(projectRoot, '.codex'));
}
