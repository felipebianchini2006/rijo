import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readTextIfExists, writeFileAtomic } from '../core/fsx.js';

export const BEGIN = '<!-- RIJO:BEGIN -->';
export const END = '<!-- RIJO:END -->';

/**
 * Idempotent marker-block upsert: RIJO only ever edits the region between its
 * markers; manual content outside the block is preserved byte-for-byte.
 */
export function upsertMarkerBlock(existing: string | null, blockBody: string): string {
  const block = `${BEGIN}\n${blockBody.trim()}\n${END}`;
  if (existing === null || existing.trim() === '') return block + '\n';
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  return existing.trimEnd() + '\n\n' + block + '\n';
}

export function upsertMarkerFile(filePath: string, blockBody: string): void {
  writeFileAtomic(filePath, upsertMarkerBlock(readTextIfExists(filePath), blockBody));
}

/** The canonical instruction block injected into CLAUDE.md / AGENTS.md. */
export function rijoInstructionBlock(): string {
  return [
    '1. Leia `.rijo/STATE.md`.',
    '2. Leia `.rijo/RULES.md`.',
    '3. Leia a `SPEC.md` e a `PLAN.md` da fase ativa.',
    '4. Para brownfield, carregue primeiro `.rijo/codebase/SUMMARY.md` e consulte os índices JSON; não carregue o mapa detalhado inteiro.',
    '5. Carregue `.rijo/PROJECT.md`, `.rijo/STACK.md` e o `REQUIREMENTS.md` do milestone ativo somente quando a tarefa exigir.',
    '6. Não marque trabalho como concluído sem evidência.',
    '7. Resolva decisões técnicas reversíveis autonomamente pela política de `.rijo/config.yml`; nunca gere menus de opções.',
    '8. Após uma tarefa verificada, atualize o estado por meio do protocolo RIJO (CLI `rijo`).',
    '',
    hostBridgeNote(),
  ].join('\n');
}

/**
 * Host↔core bridge instructions injected into every adapter instruction block.
 * Turnkey mode (`rijo <cmd> --host …`) is the recommended path; the raw
 * `npx rijo serve --stdio` JSON-RPC protocol is documented afterward as the
 * advanced API for hosts that embed RIJO directly.
 */
export function hostBridgeNote(): string {
  return [
    '## Execução autônoma (turnkey)',
    '',
    'Para operar o RIJO de ponta a ponta com o seu próprio CLI, NÃO programe um loop de protocolo — use o comando turnkey e deixe o RIJO detectar o host, supervisionar cada tentativa e transmitir o progresso:',
    '',
    '```',
    'rijo run all --host claude      # ou: --host codex',
    'rijo new @PLANO.md --host claude --run',
    '```',
    '',
    '- O host vem de `--host` ou de `host.provider` no `.rijo/config.yml` (default `none`).',
    '- Um CLI de host ausente resulta em BLOCKED (exit 3) — nada é simulado. Progresso/heartbeat vão para o stderr; o resultado final `[rijo …]` sai no stdout.',
    '',
    '## Host bridge (API avançada para hosts externos)',
    '',
    'Um host que embute o RIJO diretamente pode, em vez disso, iniciar o processo bridge e falar JSON-RPC (uma mensagem JSON por linha) sobre stdio:',
    '',
    '```',
    'npx rijo serve --stdio',
    '```',
    '',
    '- Dispare um workflow enviando um request, ex.: `{"type":"request","method":"workflow.run","id":1,"params":{"target":"all"}}`',
    '  (métodos: `workflow.map|new|run|ui|fix|check`; `params` carrega as opções do workflow e um `capabilities` opcional).',
    '- O core responde cada tarefa com `{"type":"request","method":"agent.runTask","id":<n>,"params":<AgentTask>}`.',
    '  Execute o subagente descrito e responda `{"type":"response","id":<n>,"result":{...AgentResult...}}` na mesma pipe.',
    '- Progresso chega como `{"type":"notification","method":"progress","params":{"line":"..."}}` — nada não-JSON trafega no stdout.',
    '- Ao final, o core envia `{"type":"response","id":<id-do-workflow>,"result":<WorkflowOutcome>}`.',
  ].join('\n');
}

/** Root of the installed rijo package (dist/adapters/shared.js -> ../..). */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/adapters or src/adapters — package root is two levels up
  return path.resolve(here, '..', '..');
}

/** Load a canonical skill source shipped with the package. */
export function loadSkillSource(name: string): string | null {
  const p = path.join(packageRoot(), 'skills', `${name}.md`);
  return exists(p) ? readTextIfExists(p) : null;
}

export interface AdapterReport {
  generated: string[];
  skipped: string[];
  notes: string[];
}
