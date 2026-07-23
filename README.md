# RIJO

Framework de contexto e execução autônoma para desenvolvedores freelancers.
Converte um escopo fechado (um plano de desenvolvimento em Markdown) em
contexto persistente, pesquisa técnica, fases executáveis, código verificado e
evidências de prontidão.

Prioridades, nesta ordem: confiabilidade verificável · poucos comandos ·
automação sem perguntas desnecessárias · economia de tokens · recuperação
segura após interrupções · independência de provedor · greenfield e brownfield.

## Instalação

Requisitos: Node.js ≥ 22 (Node 24 LTS recomendado) e Git.

```bash
# primeira execução sem instalação global
npx rijo@0.1.0 new @PLANO.md

# recomendado: dependência local fixada no lockfile
npm install --save-dev rijo
npx rijo run

# conveniência pessoal (não define a versão canônica do projeto)
npm install --global rijo
rijo --status
```

Antes da publicação no npm, instale por tag Git — mesmo CLI, mesmo layout:

```bash
npm install --save-dev git+https://github.com/<owner>/rijo.git#v0.1.0
```

## Os cinco comandos

```text
rijo new @PLANO.md                      # cria M001 a partir do plano
rijo new @NOVO-PLANO.md --next          # sela o milestone atual e cria o próximo
rijo new @PLANO.md --ui @design.zip --run
rijo run                                # retoma do checkpoint (STATE.md)
rijo run all | next | 03
rijo ui @design.zip                     # importa design como referência visual
rijo fix "descrição do problema" @log.txt
rijo check [--fix] [--production]       # decisão READY/NOT_READY/BLOCKED
```

Invocações somente leitura (não planejam, não executam, não alteram contexto):

```text
rijo                 # painel resumido
rijo --status        # snapshot legível
rijo --status --json # snapshot para automação (schema estável)
rijo --watch         # acompanha o status sem chamadas de modelo
```

## Como funciona

- **Artefatos, não conversa.** A verdade vive em `.rijo/` — arquivos pequenos,
  versionáveis e legíveis. `STATE.md` só avança em checkpoint verificado;
  `runtime/status.json` é o estado volátil; `events.jsonl` é o log de auditoria.
- **Código para determinismo, IA para julgamento.** Schemas, locks, escrita
  atômica, cobertura requisito-fase-teste, extração segura de ZIP e detecção
  de drift são código. Agentes fazem pesquisa, especificação, planejamento,
  implementação e revisão — cada um com contexto fresco e brief explícito
  (objetivo, arquivos, escopo de escrita, critérios, comandos, formato).
- **Evidência antes de conclusão.** Nenhuma fase fecha sem comandos executados,
  códigos de saída e commit registrados em `VERIFICATION.md`.
- **Loops limitados.** 2 revisões de plano, 2 ciclos de review/reparo,
  2 tentativas de QA-fix, 2 tentativas de fix rápido, 4 agentes paralelos,
  2–4 tarefas por fase. Excedeu, bloqueia com diagnóstico.
- **Milestones selados.** `rijo new --next` fecha o contrato atual
  (COMPLETE/PARTIAL/SUPERSEDED/CANCELLED), gera `CLOSEOUT.md`, transfere
  requisitos com `carried_from` e cria o próximo. Histórico imutável.

## Máquina de estados do `rijo run`

```text
LOAD → RESEARCH_DELTA → SPEC_READY → PLAN → PLAN_LINT → PLAN_REVIEW
     → EXECUTE → VERIFY → CODE_REVIEW → UI_SMOKE → PERSIST → COMMIT → DONE
```

Interrupções retomam do último checkpoint verificado sem repetir trabalho.

## Agentes e modelos

O core não conhece nomes de modelos. `.rijo/config.yml` mapeia papéis a tiers
(veja `docs/models.md`):

```yaml
models:
  lead: strongest
  reviewer: strongest-independent
  planner: balanced-reasoning
  worker: economical-coding
  researcher: economical-research
  qa: economical-browser
```

O RIJO roda dentro de um runtime de agentes (Claude Code, Codex) através dos
adapters instalados por `rijo new` — skills em `.claude/skills/` e
`.agents/skills/`, blocos idempotentes em `CLAUDE.md`/`AGENTS.md` e uma status
line que lê `.rijo/runtime/status.json`. Programaticamente, injete um
`AgentRunner` próprio:

```ts
import { runWorkflow, type AgentRunner } from 'rijo';
const outcome = await runWorkflow(process.cwd(), { target: 'all' }, { runner: myRunner });
```

Sem runtime vinculado, os workflows param com diagnóstico preciso — nunca
simulam trabalho de agente.

## Exemplos

- `examples/greenfield/` — plano completo que gera M001 com duas fases.
- `examples/brownfield/` — como apontar o RIJO para um repositório existente.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm test          # unit + integração + golden + E2E com agent runner falso
npm pack          # valida o tarball (prepack roda o build)
```

CI recomendado: testes → `npm pack` → instalar o tarball em fixture vazia →
executar o CLI empacotado (o teste `tests/pack.e2e.test.ts` automatiza isso).

## Segurança e licenças

Veja `SECURITY.md` (política operacional: redaction, ZIP seguro, escopos de
escrita, nunca deploy) e `THIRD_PARTY_NOTICES.md` (linhagem conceitual dos
projetos de referência, todos MIT). RIJO é MIT.
