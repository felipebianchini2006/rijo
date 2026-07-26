# RIJO Codebase Map

`rijo map` cria uma base brownfield consultável, vinculada ao commit e ao hash
determinístico da árvore relevante. O comando não possui perguntas nem menus:

- sem mapa ou com commit-base inacessível: full;
- mapa no mesmo conteúdo: no-op;
- drift Git ou paths marcados por uma fase/fix verificado: incremental;
- `--full`: full explícito;
- `--paths a,b`: somente módulos owners desses paths, mais a síntese
  transversal;
- `--query termo`: consulta `inventory`, `symbols`, `surfaces`, dependências e
  claims localmente, com `model_calls: 0`;
- `--status`: commit, freshness, cobertura, baseline, módulos e gaps.

## Pipeline e limites

1. `MAP_PREFLIGHT` resolve a raiz real e exige checkout limpo, exceto estado
   volátil autorizado do RIJO.
2. `MAP_INVENTORY` classifica cada arquivo relevante e registra exclusões.
   Sensitive paths, `.env`, credenciais locais, vendor, generated, binários,
   arquivos grandes e symlinks externos são fail-closed e não são enviados aos
   agentes.
3. `MAP_HISTORY` calcula renames, churn, co-change, commits arquiteturais,
   migrations e hotspots sem enviar o log inteiro ao modelo.
4. `MAP_SHARDS` agrupa módulos reais com owner único e limites de arquivos e
   bytes, subdividindo módulos grandes sem perder ownership. Cada tentativa
   passa pelo `TaskExecutor` e `Supervisor`, recebe apenas seu shard e não possui
   write scope. Shards somente documentais/visuais continuam inventariados, mas
   a ausência esperada de código neles não vira gap.
5. `MAP_SYNTHESIS` preserva claims não afetadas e mescla fragments Zod.
6. `MAP_REVIEW` revalida path, sha256, linhas e símbolos em shards limitados,
   cobre todas as claims e persiste recibos estruturais e semânticos. Se a
   camada enriquecida for reprovada, ela é descartada integralmente e o
   candidato determinístico é submetido a uma nova revisão independente.
7. `MAP_BASELINE` executa comandos detectados em `AttemptWorkspace`, pela
   política segura. Detecção sozinha é `DETECTED_NOT_RUN`, nunca “verified”.
8. `MAP_COMMIT` promove o candidato por transação recuperável. Um crash antes
   do commit point descarta staging; depois dele, o recovery faz roll-forward.

Mappers nunca escrevem no código da aplicação. O core captura a árvore antes e
depois de cada batch read-only e bloqueia qualquer delta.

## Artefatos

`.rijo/codebase/` contém os documentos de planejamento (`SUMMARY`, `STACK`,
`ARCHITECTURE`, `STRUCTURE`, `MODULES`, `CONVENTIONS`, `TESTING`, `APIS`,
`DATA`, `INTEGRATIONS`, `OPERATIONS`, `HISTORY`, `CONCERNS`, `BASELINE`) e os
índices JSON (`inventory`, `symbols`, `dependency-graph`, `surfaces`, `claims`,
`baseline`, `review-receipts`, `map-state`). `map-state.json` registra
schema/mapper, status derivado (`COMPLETE`, `PARTIAL` ou `BLOCKED`), commit,
tree hash, branch, cobertura multidimensional real, exclusões, hashes dos
artefatos, baseline, drift e operação. A revisão nunca é truncada por quantidade
de claims. Observações livres do mapper só afetam o status quando a revisão
independente as certifica como lacuna material; caso contrário, permanecem
rastreáveis em `CONCERNS.md` e `review-receipts.json` como não bloqueantes.

`SUMMARY.md` é o único documento carregado por padrão. O packet dirigido usa o
texto do plano para selecionar módulos, arquivos, símbolos, contratos e riscos
dentro de `context_budget_bytes`. Paths, hashes ou símbolos existentes
inventados pelo planner reprovam `PLAN_LINT`.

## Integração com `new`

Greenfield segue sem mapa. Em brownfield, `new` chama `ensureCodebaseMap` dentro
do lock que já possui: cria full quando ausente, reutiliza quando fresh e
atualiza incrementalmente quando stale. `new --next` faz essa garantia antes da
classificação de requisitos. Um mapa `BLOCKED` nunca é consumido. Um mapa
`PARTIAL` só bloqueia quando seus gaps factuais atingem paths ou módulos do
escopo planejado; gaps não relacionados permanecem visíveis sem impedir trabalho
seguro.

## Decisões

O schema v3 adiciona `decisions` à configuração:

```yaml
decisions:
  mode: autonomous
  ask_user: blockers_only
  preserve_existing_architecture: true
  prefer_reversible: true
  record_material_decisions: true
  confidence_threshold: 0.70
  scale_horizon: current_scope_plus_next_milestone
```

O core resolve gray areas pela ordem: escopo explícito; comportamento
observável/testes/dados; mapa e padrão dominante; segurança e compatibilidade;
documentação oficial; alternativa simples e reversível; escala do escopo atual
e próximo milestone. Só aceita blockers externos enumerados pelo schema. Uma
decisão material sem evidência real é inválida; uma dúvida técnica reversível
abaixo do threshold preserva comportamento ou escolhe a alternativa simples e
registra condição objetiva de revisão.

Toda resposta de agente pode propor decisões pelo contrato
`decision_proposals`. O core valida evidência, blocker, confiança,
reversibilidade, consequências e condição de revisão antes de aceitar a
resposta; propostas materiais válidas são promovidas a `DecisionRecord` somente
no terminal durável do workflow.
