import * as fs from 'node:fs';
import { parseArgs } from 'node:util';
import { RijoPaths } from '../core/paths.js';
import { readStatus, renderStatusLine } from '../core/progress.js';
import { readState } from '../core/state.js';
import { readManifest, RIJO_VERSION } from '../core/manifest.js';
import { newWorkflow } from '../workflows/new.js';
import { runWorkflow } from '../workflows/run.js';
import { uiWorkflow } from '../workflows/ui.js';
import { fixWorkflow } from '../workflows/fix.js';
import { checkWorkflow } from '../workflows/check.js';
import { serve } from './serve.js';
import { generateAdapters, type AdapterName } from '../adapters/index.js';
import type { WorkflowDeps, WorkflowOutcome } from '../workflows/shared.js';

/**
 * Workflow commands: new, run, ui, fix, check.
 * Read-only invocations: rijo | rijo --status [--json] | rijo --watch.
 * `deps` is injectable for tests (fake agent runner, fake shell, fake git).
 */
export async function runCli(argv: string[], deps: WorkflowDeps = {}, cwd = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command.startsWith('-')) {
    return statusCli(argv, cwd);
  }

  switch (command) {
    case 'new': {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          next: { type: 'boolean' },
          milestone: { type: 'boolean' },
          run: { type: 'boolean' },
          ui: { type: 'string' },
        },
      });
      const plan = positionals[0];
      if (!plan) return usage('rijo new @PLANO.md [--next] [--ui @design.zip] [--run]');
      return report(
        await newWorkflow(
          cwd,
          { planFile: plan, next: Boolean(values.next || values.milestone), run: Boolean(values.run), ui: values.ui },
          deps,
        ),
      );
    }
    case 'run': {
      const target = rest[0];
      if (target && !['next', 'all'].includes(target) && !/^\d{2}$/.test(target)) {
        return usage('rijo run [next|all|NN]');
      }
      return report(await runWorkflow(cwd, { target }, deps));
    }
    case 'ui': {
      const input = rest[0];
      if (!input) return usage('rijo ui @design.zip | @index.html | @design-directory/');
      return report(await uiWorkflow(cwd, { input }, deps));
    }
    case 'fix': {
      const description = rest.filter((a) => !a.startsWith('@')).join(' ');
      const evidence = rest.filter((a) => a.startsWith('@')).map((a) => a.slice(1));
      if (!description) return usage('rijo fix "problem description" [@evidence.png] [@log.txt]');
      return report(await fixWorkflow(cwd, { description, evidenceFiles: evidence }, deps));
    }
    case 'check': {
      const { values } = parseArgs({
        args: rest,
        options: { fix: { type: 'boolean' }, production: { type: 'boolean' } },
      });
      return report(await checkWorkflow(cwd, { fix: values.fix, production: values.production }, deps));
    }
    case 'serve': {
      // Host↔core JSON-RPC bridge over stdio (the default and only mode).
      // A host speaks the protocol to drive workflows and answer agent.runTask.
      await serve();
      return 0;
    }
    case 'adapters': {
      // maintenance command (informational for workflows; regenerates adapter files)
      const force = rest.filter((r): r is AdapterName => ['claude', 'codex', 'generic'].includes(r));
      const r = generateAdapters(cwd, force.length ? force : undefined);
      console.log(`generated: ${r.generated.join(', ') || 'none'}`);
      if (r.skipped.length) console.log(`skipped: ${r.skipped.join(', ')}`);
      return 0;
    }
    default:
      return usage(`unknown command "${command}". Workflows: new, run, ui, fix, check.`);
  }
}

function usage(message: string): number {
  console.error(`rijo: ${message}`);
  return 2;
}

function report(outcome: WorkflowOutcome): number {
  const prefix = outcome.status === 'completed' ? 'done' : outcome.status;
  console.log(`[rijo ${prefix}] ${outcome.message}`);
  for (const d of outcome.details ?? []) console.log(`  ${d}`);
  return outcome.ok ? 0 : outcome.status === 'blocked' ? 3 : 1;
}

/** Read-only status panel: never plans, executes, fixes or mutates context. */
async function statusCli(argv: string[], cwd: string): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      status: { type: 'boolean' },
      json: { type: 'boolean' },
      watch: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(RIJO_VERSION);
    return 0;
  }
  const paths = new RijoPaths(cwd);

  if (values.watch) {
    console.log('rijo --watch: acompanhando .rijo/runtime/status.json (Ctrl+C para sair)');
    let last = '';
    const tick = () => {
      const s = readStatus(paths);
      const line = s ? renderStatusLine(s) : '[RIJO] idle';
      if (line !== last) {
        console.log(line);
        last = line;
      }
    };
    tick();
    await new Promise<void>((resolve) => {
      const interval = setInterval(tick, 1000);
      process.on('SIGINT', () => {
        clearInterval(interval);
        resolve();
      });
    });
    return 0;
  }

  const manifest = fs.existsSync(paths.manifest) ? readManifest(paths) : null;
  const status = readStatus(paths);
  const state = readState(paths);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          schema_version: 1,
          rijo_version: RIJO_VERSION,
          initialized: manifest !== null,
          active_milestone: manifest?.active_milestone ?? null,
          milestones: manifest?.milestones ?? [],
          runtime: status,
          checkpoint: state,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!manifest) {
    console.log('[RIJO] não inicializado. Comece com: rijo new @PLANO.md');
    return 0;
  }
  console.log(`RIJO ${RIJO_VERSION} — milestone ativo: ${manifest.active_milestone ?? 'nenhum'}`);
  for (const m of manifest.milestones) console.log(`  ${m.id}  ${m.slug}  ${m.status}`);
  if (status) console.log(`runtime: ${renderStatusLine(status)} (${status.status})`);
  if (state) {
    console.log(
      `checkpoint: milestone=${state.milestone ?? '—'} fase=${state.phase ?? '—'} stage=${state.stage ?? '—'}${state.blocked ? ` BLOQUEADO: ${state.blocked_reason}` : ''}`,
    );
    if (state.next_step) console.log(`próximo passo: ${state.next_step}`);
  }
  return 0;
}

const HELP = `rijo — context and autonomous execution framework

workflows:
  rijo new @PLANO.md [--next] [--ui @design.zip] [--run]
  rijo run [next|all|NN]
  rijo ui @design.zip | @index.html | @dir/
  rijo fix "descrição" [@evidence]
  rijo check [--fix] [--production]

read-only:
  rijo                painel resumido
  rijo --status       snapshot legível
  rijo --status --json snapshot para automação
  rijo --watch        acompanha o status sem iniciar trabalho
`;
