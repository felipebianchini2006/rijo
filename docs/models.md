# Modelos, papéis e custos

O core do RIJO nunca fixa nomes de modelos. `.rijo/config.yml` mapeia seis
papéis a tiers de texto livre; o runtime (adapter ou `AgentRunner` injetado)
resolve cada tier para um modelo concreto disponível.

## Papéis

| Papel | Responsabilidade | Tier padrão | Perfil de custo |
|---|---|---|---|
| `lead` | orquestração fina, diagnóstico de fix | `strongest` | poucas chamadas, contexto pequeno |
| `reviewer` | revisão independente de plano/código/visual | `strongest-independent` | 1–2 chamadas por fase; recebe spec+diff+evidência, nunca o raciocínio do autor |
| `planner` | extração de plano, SPEC.md, PLAN.md | `balanced-reasoning` | 1–3 chamadas por fase (limite de 2 revisões) |
| `worker` | implementação de uma tarefa com escopo estrito | `economical-coding` | 2–4 por fase; contexto fresco e mínimo |
| `researcher` | pesquisa delta com fontes oficiais | `economical-research` | até 4 em paralelo no M001; cache depois |
| `qa` | jornadas de browser, smoke visual | `economical-browser` | 1 por jornada; só quando há browser |

Configuração premium-coordena/barato-executa (recomendada para freelancers):

```yaml
models:
  lead: strongest
  reviewer: strongest-independent   # DEVE ser independente do autor
  planner: balanced-reasoning
  worker: economical-coding
  researcher: economical-research
  qa: economical-browser
limits:
  plan_revisions: 2
  review_loops: 2
  qa_fix_loops: 2
  fix_attempts: 2
  max_parallel_agents: 4
```

Remapear papéis nunca exige mudança no core (testado em
`tests/agents.test.ts`). Runtimes sem subagentes/paralelismo executam os mesmos
papéis sequencialmente — o RIJO nunca finge que uma capacidade foi usada.

## Onde os tokens são gastos (e onde não são)

Gastam tokens: extração do plano (1×/milestone), pesquisa (cacheada,
delta-only), spec+plano (por fase, revisões limitadas), workers (por tarefa),
reviews (limitadas), jornadas de QA.

Nunca gastam tokens: validação de schema, lint de plano, cobertura
requisito-teste, locks, escrita atômica, transições de estado, detecção de
drift, `rijo --status/--watch`, status line, retomada de checkpoint — tudo
código determinístico.

Regras de economia embutidas: contexto automático < 24 KB por execução;
subagentes recebem briefs, não o repositório; pesquisa revalida apenas decisões
voláteis (TTL 30 dias); mensagens de chat só em transições materiais; sem
heartbeats para o modelo; percentuais apenas de unidades conhecidas.
