# Plano de desenvolvimento — Agenda Fácil

## Objetivo

Aplicação web mínima para agendamento de horários de um profissional autônomo.

## Requisitos funcionais

1. Página pública com a agenda semanal e horários livres.
2. Cliente reserva um horário informando nome e e-mail; recebe confirmação.
3. Painel do profissional (login simples) para bloquear horários e ver reservas.

## Requisitos não funcionais

- Responsivo (desktop e mobile).
- Sem dados pessoais em logs.

## Fora de escopo

- Pagamentos, notificações por SMS, multiusuário.

## Critérios de aceite

- Fluxo completo de reserva funciona de ponta a ponta em ambiente local.
- Painel exige autenticação.

## Como usar este exemplo

```bash
mkdir agenda-facil && cd agenda-facil
cp ../examples/greenfield/PLANO.md .
npx rijo new @PLANO.md --run
rijo --watch   # em outro terminal
```
