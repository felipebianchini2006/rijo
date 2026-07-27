import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { RijoPaths } from '../core/paths.js';
import { TaskRecordSchema, type TaskRecord } from '../core/schemas/index.js';
import { readStatus, renderStatusLine, stderrSink } from '../core/progress.js';
import { readState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { buildHostExecutor, resolveHostProvider } from './host.js';
import { readManifest, RIJO_VERSION } from '../core/manifest.js';
import { newWorkflow } from '../workflows/new.js';
import { runWorkflow } from '../workflows/run.js';
import { uiWorkflow } from '../workflows/ui.js';
import { fixWorkflow } from '../workflows/fix.js';
import { checkWorkflow } from '../workflows/check.js';
import { mapWorkflow, queryCodebaseMap, readCodebaseMapStatus } from '../workflows/map.js';
import { serve } from './serve.js';
import { generateAdapters, type AdapterName } from '../adapters/index.js';
import { openDurableWorkflowEngine } from '../durable/index.js';
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
    case 'map': {
      const { values } = parseArgs({
        args: rest,
        options: {
          full: { type: 'boolean' },
          paths: { type: 'string' },
          query: { type: 'string' },
          status: { type: 'boolean' },
          host: { type: 'string' },
        },
      });
      if (values.query !== undefined) {
        console.log(JSON.stringify(queryCodebaseMap(cwd, values.query), null, 2));
        return 0;
      }
      if (values.status) {
        const status = readCodebaseMapStatus(cwd);
        if (!status) return report({ ok: false, status: 'failed', message: 'No codebase map exists.' });
        console.log(JSON.stringify(status, null, 2));
        return 0;
      }
      const scopes = values.paths?.split(',').map((value) => value.trim()).filter(Boolean);
      return withHost(cwd, values.host, deps, (d) =>
        mapWorkflow(cwd, { full: Boolean(values.full), paths: scopes }, d),
      );
    }
    case 'new': {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          next: { type: 'boolean' },
          milestone: { type: 'boolean' },
          run: { type: 'boolean' },
          ui: { type: 'string' },
          host: { type: 'string' },
        },
      });
      const plan = positionals[0];
      if (!plan) return usage('rijo new @PLANO.md [--next] [--ui @design.zip] [--run] [--host claude|codex]');
      return withHost(cwd, values.host, deps, (d) =>
        newWorkflow(
          cwd,
          { planFile: plan, next: Boolean(values.next || values.milestone), run: Boolean(values.run), ui: values.ui },
          d,
        ),
      );
    }
    case 'run': {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { host: { type: 'string' } },
      });
      const target = positionals[0];
      if (target && !['next', 'all'].includes(target) && !/^\d{2}$/.test(target)) {
        return usage('rijo run [next|all|NN] [--host claude|codex]');
      }
      const effectiveTarget =
        target ?? (process.env['RIJO_ENGINE_CHILD'] === '1' ? 'all' : undefined);
      return withHost(cwd, values.host, deps, (d) =>
        runWorkflow(cwd, { target: effectiveTarget }, d),
      );
    }
    case 'ui': {
      const { host, rest: uiRest } = extractHostFlag(rest);
      const input = uiRest[0];
      if (!input) return usage('rijo ui @design.zip | @index.html | @design-directory/ [--host claude|codex]');
      return withHost(cwd, host, deps, (d) => uiWorkflow(cwd, { input }, d));
    }
    case 'fix': {
      const { host, rest: fixRest } = extractHostFlag(rest);
      const description = fixRest.filter((a) => !a.startsWith('@')).join(' ');
      const evidence = fixRest.filter((a) => a.startsWith('@')).map((a) => a.slice(1));
      if (!description) return usage('rijo fix "problem description" [@evidence.png] [@log.txt] [--host claude|codex]');
      return withHost(cwd, host, deps, (d) => fixWorkflow(cwd, { description, evidenceFiles: evidence }, d));
    }
    case 'check': {
      const { values } = parseArgs({
        args: rest,
        options: { fix: { type: 'boolean' }, production: { type: 'boolean' }, host: { type: 'string' } },
      });
      return withHost(cwd, values.host, deps, (d) =>
        checkWorkflow(cwd, { fix: values.fix, production: values.production }, d),
      );
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
      return usage(`unknown command "${command}". Workflows: map, new, run, ui, fix, check.`);
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

/**
 * Resolve the host binding, then run a workflow turnkey against it. With
 * `--host claude|codex` (or `config.host.provider`) the real CLI host is
 * detected, wrapped in a supervised executor and injected into the workflow —
 * a missing host BLOCKS (exit 3), an invalid flag is a usage error (exit 2).
 * Progress/heartbeat lines go to stderr so stdout stays the command result.
 * With provider 'none' the workflow runs exactly as before (no host coupling).
 * The host executor is always disposed after the run (supervisor timers freed).
 */
async function withHost(
  cwd: string,
  hostFlag: string | undefined,
  deps: WorkflowDeps,
  body: (deps: WorkflowDeps) => Promise<WorkflowOutcome>,
): Promise<number> {
  const durableBinding = await attachProductionDurableEngine(cwd, deps);
  const durableDeps = durableBinding.deps;
  const config = loadConfig(new RijoPaths(cwd));
  const provider = resolveHostProvider(hostFlag, config);
  if (typeof provider === 'object') {
    await closeOwnedDurable(durableBinding);
    return usage(provider.error);
  }
  if (provider === 'none') {
    try {
      return report(await body({ ...durableDeps, hostProvider: provider }));
    } finally {
      await closeOwnedDurable(durableBinding);
    }
  }

  const boot = await buildHostExecutor({ provider, projectRoot: cwd, config, paths: new RijoPaths(cwd) });
  if (!boot.ok) {
    await closeOwnedDurable(durableBinding);
    return report({ ok: false, status: 'blocked', message: boot.message, details: boot.details });
  }
  try {
    return report(
      await body({
        ...durableDeps,
        hostProvider: provider,
        executor: boot.executor,
        sink: durableDeps.sink ?? stderrSink,
      }),
    );
  } finally {
    await boot.executor.dispose();
    await closeOwnedDurable(durableBinding);
  }
}

/**
 * The packaged CLI always uses the SQLite-backed Durable State Engine. Tests
 * and embedders that inject any runtime dependency retain full control and may
 * explicitly pass `durable: null` or their own in-memory/test implementation.
 */
async function attachProductionDurableEngine(
  cwd: string,
  deps: WorkflowDeps,
): Promise<{ deps: WorkflowDeps; owned: boolean }> {
  if (Object.prototype.hasOwnProperty.call(deps, 'durable')) return { deps, owned: false };
  const injectedRuntime =
    deps.runner !== undefined ||
    deps.executor !== undefined ||
    deps.shell !== undefined ||
    deps.git !== undefined ||
    deps.now !== undefined ||
    deps.clock !== undefined ||
    deps.supervisorConfig !== undefined;
  if (injectedRuntime) return { deps, owned: false };
  return {
    deps: { ...deps, durable: await openDurableWorkflowEngine(cwd) },
    owned: true,
  };
}

async function closeOwnedDurable(binding: {
  deps: WorkflowDeps;
  owned: boolean;
}): Promise<void> {
  if (!binding.owned) return;
  await binding.deps.durable?.close();
}

/**
 * Extract a `--host <value>` (or `--host=<value>`) flag from a free-form argv
 * that also carries positional/`@evidence` tokens (fix/ui), leaving the rest
 * untouched. Returns the flag value (if any) and the remaining args.
 */
function extractHostFlag(args: string[]): { host: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let host: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--host') {
      host = args[i + 1];
      i++;
      continue;
    }
    const m = a.match(/^--host=(.*)$/);
    if (m) {
      host = m[1];
      continue;
    }
    rest.push(a);
  }
  return { host, rest };
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
  const supervised = readSupervisedTasks(paths);
  const codebase = readCodebaseMapStatus(cwd);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          // v3 is additive over v2: codebase-map status is added; all v2
          // fields keep their shape for older consumers.
          schema_version: 3,
          rijo_version: RIJO_VERSION,
          initialized: manifest !== null,
          active_milestone: manifest?.active_milestone ?? null,
          milestones: manifest?.milestones ?? [],
          runtime: status,
          checkpoint: state,
          codebase,
          supervisor: {
            tasks: supervised.map((t) => ({
              logical_task_id: t.logical_task_id,
              role: t.role,
              state: t.state,
              attempt_id: t.attempt_id,
              generation: t.generation,
              replacements: t.replacement_count,
              host: t.host,
              last_heartbeat_at: t.last_heartbeat_at,
              last_progress_at: t.last_progress_at,
              hard_deadline_at: t.hard_deadline_at,
              last_error: t.last_error,
            })),
          },
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
  // supervisor panel: one block per non-terminal supervised attempt
  const active = readSupervisedTasks(paths).filter(
    (t) => !['SUCCEEDED', 'FAILED', 'EXHAUSTED', 'CANCELLED'].includes(t.state),
  );
  if (active.length > 0) {
    const maxReplacements = loadConfig(paths).supervisor.max_replacements_per_task;
    const age = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))}s` : '—');
    for (const t of active) {
      console.log(
        `${t.role}: attempt ${t.generation}, generation ${t.generation}\n` +
          `last heartbeat: ${age(t.last_heartbeat_at)}\n` +
          `last progress: ${age(t.last_progress_at)}\n` +
          `replacements: ${t.replacement_count}/${maxReplacements}\n` +
          `state: ${t.state}`,
      );
    }
  }
  return 0;
}

/** Non-terminal supervised task records from .rijo/runtime/tasks (tolerant read). */
function readSupervisedTasks(paths: RijoPaths): TaskRecord[] {
  const dir = path.join(paths.runtimeDir, 'tasks');
  if (!fs.existsSync(dir)) return [];
  const out: TaskRecord[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const parsed = TaskRecordSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* unreadable record: ignored in the read-only panel */
    }
  }
  return out;
}

const HELP = `rijo — context and autonomous execution framework

workflows:
  rijo map [--full] [--paths src/a,src/b] [--query "term"] [--status] [--host claude|codex]
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
