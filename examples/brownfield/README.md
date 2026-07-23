# Exemplo brownfield

Apontar o RIJO para um repositório existente não reescreve nada: a detecção de
brownfield mapeia stack, dependências e comandos reais (`npm run build/lint/
test/typecheck`), registra o comportamento preexistente em `STACK.md` e passa
esse contexto ao planejamento. A precedência da verdade coloca contratos,
testes e comportamento existente ACIMA dos artefatos do RIJO e da pesquisa.

```bash
cd meu-projeto-existente          # já tem código e git
npx rijo new @NOVO-ESCOPO.md      # M001 respeitando o stack atual
rijo run
```

Regras que o RIJO aplica automaticamente em brownfield:

- preserva stack, padrões e contratos existentes, exceto quando inseguros ou
  incompatíveis com o escopo — e toda alteração estrutural precisa registrar
  custo, risco e migração;
- executa o baseline (build/test) quando seguro, antes de planejar;
- alterações locais desconhecidas nunca são descartadas ou escondidas por
  stash: o fluxo bloqueia com diagnóstico;
- um novo contrato (`rijo new @PLANO2.md --next`) compara o plano com o código
  atual e classifica cada item como NEW / CHANGE / REMOVE / CARRYOVER /
  UNCHANGED_DEPENDENCY.
