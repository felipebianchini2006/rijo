import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { RijoPaths } from '../core/paths.js';
import { appendLine, ensureDir, readJson } from '../core/fsx.js';
import { TaskRecordSchema, type TaskRecord } from '../core/schemas/index.js';
import { readStatus, renderStatusLine, stderrSink } from '../core/progress.js';
import { readState } from '../core/state.js';
import { loadConfig } from '../core/config.js';
import { buildHostExecutor, resolveHostProvider } from './host.js';
import { readManifest, RIJO_VERSION } from '../core/manifest.js';
import { lintPlan, readPlan } from '../core/plan.js';
import { newWorkflow } from '../workflows/new.js';
import { runWorkflow } from '../workflows/run.js';
import { recoverNativeState, resumeWorkflow } from '../workflows/resume.js';
import { startWorkflow } from '../workflows/run.js';
import { uiWorkflow } from '../workflows/ui.js';
import { fixWorkflow } from '../workflows/fix.js';
import { checkWorkflow } from '../workflows/check.js';
import { testWorkflow } from '../workflows/check.js';
import { finishWorkflow } from '../workflows/finish.js';
import { nextWorkflow } from '../workflows/next.js';
import { mapWorkflow, queryCodebaseMap, readCodebaseMapStatus } from '../workflows/map.js';
import { serve } from './serve.js';
import { generateAdapters, type AdapterName } from '../adapters/index.js';
import { openDurableWorkflowEngine } from '../durable/index.js';
import type { WorkflowDeps, WorkflowOutcome } from '../workflows/shared.js';
import {
  installProjectDependency,
  installRijo,
  type InstallHost,
} from '../install/index.js';
import {
  NativeRequestV2Schema,
  NativeResultRunner,
} from '../agents/native-results.js';
import {
  NativeLifecycleLedger,
  createNativeLifecycleEvent,
} from '../agents/native-lifecycle.js';
import { activeMilestone } from '../core/milestones.js';
import { readRequirements, readRoadmap } from '../core/roadmap.js';
import { SystemShellRunner } from '../core/commands.js';
import { openQaCheckpoint } from '../workflows/qa-checkpoint.js';

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
    case 'map-codebase':
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
      if (command === 'map-codebase' && values.host) {
        return usage('`--host` is available only on the deprecated `map` compatibility route.');
      }
      const body = (d: WorkflowDeps) =>
        mapWorkflow(cwd, { full: Boolean(values.full), paths: scopes }, d);
      return command === 'map-codebase'
        ? withNative(cwd, deps, body)
        : withHost(cwd, values.host, deps, body);
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
      if (!plan) return usage('rijo new @PLAN.md');
      const legacy = Boolean(values.host || values.run || values.next || values.milestone);
      const body = (d: WorkflowDeps) =>
        newWorkflow(cwd, {
          planFile: plan,
          next: Boolean(values.next || values.milestone),
          run: legacy && Boolean(values.run),
          ui: values.ui,
        }, d);
      return legacy
        ? withHost(cwd, values.host, deps, body)
        : withNative(cwd, deps, body);
    }
    case 'start': {
      if (rest.length > 0) return usage('rijo start');
      return withNative(cwd, deps, (d) => startWorkflow(cwd, d));
    }
    case 'run': {
      console.error('rijo: `run` is deprecated. Use `start`.');
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
      const body = (d: WorkflowDeps) => runWorkflow(cwd, { target: effectiveTarget }, d);
      return values.host
        ? withHost(cwd, values.host, deps, body)
        : withNative(cwd, deps, body);
    }
    case 'ui': {
      const { host, rest: uiRest } = extractHostFlag(rest);
      if (uiRest.length === 0) return usage('rijo ui @index.html [@design.zip] [@design-directory/]');
      return host
        ? withHost(cwd, host, deps, (d) => uiWorkflow(cwd, { inputs: uiRest }, d))
        : withNative(cwd, deps, (d) => uiWorkflow(cwd, { inputs: uiRest }, d));
    }
    case 'fix': {
      const { host, rest: fixRest } = extractHostFlag(rest);
      const description = fixRest.filter((a) => !a.startsWith('@')).join(' ');
      const evidence = fixRest.filter((a) => a.startsWith('@')).map((a) => a.slice(1));
      if (!description) return usage('rijo fix "problem description" [@evidence.png] [@log.txt] [--host claude|codex]');
      return host
        ? withHost(cwd, host, deps, (d) => fixWorkflow(cwd, { description, evidenceFiles: evidence }, d))
        : withNative(cwd, deps, (d) => fixWorkflow(cwd, { description, evidenceFiles: evidence }, d));
    }
    case 'test': {
      const { values } = parseArgs({
        args: rest,
        options: { fix: { type: 'boolean' } },
      });
      return withNative(cwd, deps, (d) => testWorkflow(cwd, { fix: values.fix }, d));
    }
    case 'check': {
      console.error('rijo: `check` is deprecated. Use `test`.');
      const { values } = parseArgs({
        args: rest,
        options: { fix: { type: 'boolean' }, production: { type: 'boolean' }, host: { type: 'string' } },
      });
      const body = (d: WorkflowDeps) =>
        checkWorkflow(cwd, { fix: values.fix, production: values.production }, d);
      return values.host
        ? withHost(cwd, values.host, deps, body)
        : withNative(cwd, deps, body);
    }
    case 'finish': {
      if (rest.length > 0) return usage('rijo finish');
      return withNative(cwd, deps, (d) => finishWorkflow(cwd, d));
    }
    case 'next': {
      const plan = rest[0];
      if (!plan || rest.length > 1) return usage('rijo next @NEXT-PLAN.md');
      return withNative(cwd, deps, (d) => nextWorkflow(cwd, plan, d));
    }
    case 'status':
      return statusCli(rest, cwd);
    case 'resume': {
      if (rest.length > 0) return usage('rijo resume');
      return withNative(cwd, deps, (d) => resumeWorkflow(cwd, d));
    }
    case 'internal': {
      const { resultFile, args: internalArgs } = extractNativeResultsFlag(rest);
      const [helper, ...helperArgs] = internalArgs;
      if (helper === 'status') return statusCli(helperArgs, cwd);
      if (
        [
          'task-dispatch',
          'task-start',
          'task-observe',
          'task-complete',
          'task-fail',
          'task-timeout',
          'task-cancelled',
          'task-cancel-unavailable',
        ].includes(helper ?? '')
      ) {
        const { positionals, values } = parseArgs({
          args: helperArgs,
          allowPositionals: true,
          options: {
            host: { type: 'string' },
            handle: { type: 'string' },
            detail: { type: 'string' },
          },
        });
        const requestFile = positionals[0]?.replace(/^@/, '');
        if (!requestFile || positionals.length > 1) {
          return usage(`rijo internal ${helper} @native-request.json [--host HOST] [--handle ID] [--detail TEXT]`);
        }
        try {
          const request = NativeRequestV2Schema.parse(
            readJson(path.resolve(cwd, requestFile)),
          );
          const ledger = new NativeLifecycleLedger(new RijoPaths(cwd));
          if (helper === 'task-dispatch') {
            ledger.dispatch(request);
          } else {
            const eventName = {
              'task-start': 'start',
              'task-observe': 'progress',
              'task-complete': 'complete',
              'task-fail': 'failure',
              'task-timeout': 'timeout',
              'task-cancelled': 'cancelled',
              'task-cancel-unavailable': 'cancel-unavailable',
            }[helper!] as
              | 'start'
              | 'progress'
              | 'complete'
              | 'failure'
              | 'timeout'
              | 'cancelled'
              | 'cancel-unavailable';
            ledger.record(
              createNativeLifecycleEvent(request, eventName, {
                host: values.host ?? 'native',
                host_handle: values.handle ?? null,
                detail: values.detail ?? null,
              }),
            );
          }
          return 0;
        } catch (error) {
          console.error(`rijo: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      if (helper === 'lifecycle') {
        const event = helperArgs[0];
        if (!event || helperArgs.length > 1 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(event)) {
          return usage('rijo internal lifecycle EVENT');
        }
        const paths = new RijoPaths(cwd);
        ensureDir(paths.runtimeDir);
        appendLine(
          path.join(paths.runtimeDir, 'native-hooks.jsonl'),
          JSON.stringify({ event, at: new Date().toISOString() }),
        );
        return 0;
      }
      if (helper === 'safe-command') {
        const allowLoopback = helperArgs[0] === '--loopback';
        const remainingArgs = allowLoopback ? helperArgs.slice(1) : helperArgs;
        const commandArgs = remainingArgs[0] === '--' ? remainingArgs.slice(1) : remainingArgs;
        if (commandArgs.length === 0) {
          return usage('rijo internal safe-command [--loopback] -- COMMAND');
        }
        const commandLine = commandArgs.join(' ');
        const paths = new RijoPaths(cwd);
        const evidence = new SystemShellRunner(loadConfig(paths).execution).run(commandLine, {
          cwd,
          allowLoopback,
        });
        appendLine(
          paths.events,
          JSON.stringify({
            ts: new Date().toISOString(),
            run_id: 'native-safe-command',
            type: 'internal.safe_command',
            data: evidence,
          }),
        );
        console.log(JSON.stringify(evidence));
        return evidence.exit_code === 0 ? 0 : evidence.blocked ? 3 : 1;
      }
      if (helper === 'map-codebase') {
        if (!resultFile) return usage('rijo internal map-codebase --results @.rijo/runtime/native-results.json');
        if (helperArgs.length > 0) return usage('rijo internal map-codebase --results @.rijo/runtime/native-results.json');
        return withNativeResults(cwd, resultFile, deps, (d) => mapWorkflow(cwd, {}, d));
      }
      if (helper === 'project-init') {
        const plan = helperArgs[0];
        if (!plan || helperArgs.length > 1) {
          return usage('rijo internal project-init @PLAN.md');
        }
        if (!resultFile) {
          return usage('rijo internal project-init @PLAN.md --results @.rijo/runtime/native-results.json');
        }
        return withNativeResults(cwd, resultFile, deps, (d) => newWorkflow(cwd, { planFile: plan }, d));
      }
      if (helper === 'ui-import') {
        if (helperArgs.length === 0) {
          return usage('rijo internal ui-import @index.html [@design.zip]');
        }
        if (!resultFile) {
          return usage('rijo internal ui-import @index.html [@design.zip] --results @.rijo/runtime/native-results.json');
        }
        return withNativeResults(cwd, resultFile, deps, (d) =>
          uiWorkflow(cwd, { inputs: helperArgs }, d),
        );
      }
      if (helper === 'fix-open') {
        const description = helperArgs.filter((argument) => !argument.startsWith('@')).join(' ');
        const evidenceFiles = helperArgs
          .filter((argument) => argument.startsWith('@'))
          .map((argument) => argument.slice(1));
        if (!description) return usage('rijo internal fix-open "issue description" [@evidence]');
        if (!resultFile) {
          return usage('rijo internal fix-open "issue description" [@evidence] --results @.rijo/runtime/native-results.json');
        }
        return withNativeResults(cwd, resultFile, deps, (d) =>
          fixWorkflow(cwd, { description, evidenceFiles }, d),
        );
      }
      if (helper === 'next-init') {
        const plan = helperArgs[0];
        if (!plan || helperArgs.length > 1) return usage('rijo internal next-init @NEXT-PLAN.md');
        if (!resultFile) {
          return usage('rijo internal next-init @NEXT-PLAN.md --results @.rijo/runtime/native-results.json');
        }
        return withNativeResults(cwd, resultFile, deps, (d) => nextWorkflow(cwd, plan, d));
      }
      if (helper === 'phase-open') {
        const phase = helperArgs[0];
        if (helperArgs.length > 1 || (phase && !/^\d{2}$/.test(phase))) {
          return usage('rijo internal phase-open [NN]');
        }
        if (!resultFile) {
          return usage('rijo internal phase-open [NN] --results @.rijo/runtime/native-results.json');
        }
        return withNativeResults(cwd, resultFile, deps, (d) =>
          runWorkflow(cwd, { target: phase, finalCheck: false }, d),
        );
      }
      if (helper === 'plan-validate') {
        const planFile = helperArgs[0]?.replace(/^@/, '');
        if (!planFile || helperArgs.length > 1) {
          return usage('rijo internal plan-validate @path/to/PLAN.md');
        }
        try {
          const plan = readPlan(path.resolve(cwd, planFile));
          const milestone = activeMilestone(new RijoPaths(cwd));
          const requirements = milestone ? readRequirements(milestone.paths.requirements) : null;
          const roadmap = milestone ? readRoadmap(milestone.paths.roadmap) : null;
          const phase = roadmap?.phases.find((candidate) => candidate.id === plan.phase);
          const issues = lintPlan(plan, {
            knownRequirements: new Set(requirements?.requirements.map((item) => item.id) ?? []),
            phaseRequirements: phase?.requirements,
          });
          console.log(JSON.stringify({
            valid: issues.length === 0,
            phase: plan.phase,
            tasks: plan.tasks.length,
            issues,
          }));
          return issues.length === 0 ? 0 : 1;
        } catch (error) {
          console.error(`rijo: invalid plan: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      if (helper === 'qa-open') {
        if (helperArgs.length > 0) return usage('rijo internal qa-open');
        try {
          const opened = openQaCheckpoint(cwd, deps.git);
          console.log(JSON.stringify({
            resumed: opened.resumed,
            opened_at: opened.checkpoint.opened_at,
            initial_head: opened.checkpoint.initial_head,
          }));
          return 0;
        } catch (error) {
          console.error(`rijo: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      if (helper === 'qa-record') {
        if (helperArgs.length > 0) return usage('rijo internal qa-record');
        if (!resultFile) return usage('rijo internal qa-record --results @.rijo/runtime/native-results.json');
        return withNativeResults(cwd, resultFile, deps, (d) => testWorkflow(cwd, {}, d));
      }
      if (helper === 'milestone-finish') {
        if (helperArgs.length > 0) return usage('rijo internal milestone-finish');
        return withDeterministic(cwd, deps, (d) => finishWorkflow(cwd, d));
      }
      if (helper === 'recovery') {
        if (helperArgs.length > 0) return usage('rijo internal recovery');
        return withDeterministic(cwd, deps, (d) => recoverNativeState(cwd, d));
      }
      return usage(
        'rijo internal status|task-dispatch|task-start|task-observe|task-complete|task-fail|task-timeout|task-cancelled|task-cancel-unavailable|safe-command|map-codebase|project-init|ui-import|fix-open|next-init|phase-open|plan-validate|qa-open|qa-record|milestone-finish|recovery',
      );
    }
    case 'install': {
      const { values } = parseArgs({
        args: rest,
        options: {
          codex: { type: 'boolean' },
          claude: { type: 'boolean' },
          project: { type: 'boolean' },
          user: { type: 'boolean' },
        },
      });
      if (values.project && values.user) return usage('choose one scope: --project or --user');
      const hosts = [
        ...(values.codex ? ['codex' as const] : []),
        ...(values.claude ? ['claude' as const] : []),
      ] satisfies InstallHost[];
      const scope = values.user ? 'user' : 'project';
      if (scope === 'project') {
        try {
          installProjectDependency(cwd);
        } catch (error) {
          console.error(`rijo: ${error instanceof Error ? error.message : String(error)}`);
          return 1;
        }
      }
      const result = installRijo({
        root: scope === 'user' ? os.homedir() : cwd,
        scope,
        ...(hosts.length > 0 ? { hosts } : {}),
      });
      console.log(`Installed RIJO for: ${result.hosts.join(', ') || 'no detected host'}.`);
      for (const generated of result.generated) console.log(`  ${generated}`);
      return result.hosts.length > 0 ? 0 : 1;
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
      return usage(`unknown command "${command}". Run \`rijo --help\` for supported commands.`);
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

/** Run a deterministic native route without resolving or starting a host process. */
async function withNative(
  cwd: string,
  deps: WorkflowDeps,
  body: (deps: WorkflowDeps) => Promise<WorkflowOutcome>,
): Promise<number> {
  if (!deps.runner && !deps.executor) {
    return report({
      ok: false,
      status: 'blocked',
      message: 'Use `$rijo` in Codex or `/rijo` in Claude Code. The native host must orchestrate this command.',
    });
  }
  const durableBinding = await attachProductionDurableEngine(cwd, deps);
  try {
    return report(await body({ ...durableBinding.deps, hostProvider: 'none' }));
  } finally {
    await closeOwnedDurable(durableBinding);
  }
}

/** Run a deterministic helper that does not require a native-agent result. */
async function withDeterministic(
  cwd: string,
  deps: WorkflowDeps,
  body: (deps: WorkflowDeps) => Promise<WorkflowOutcome>,
): Promise<number> {
  const durableBinding = await attachProductionDurableEngine(cwd, deps);
  try {
    return report(await body({ ...durableBinding.deps, hostProvider: 'none' }));
  } finally {
    await closeOwnedDurable(durableBinding);
  }
}

async function withNativeResults(
  cwd: string,
  resultFile: string,
  deps: WorkflowDeps,
  body: (deps: WorkflowDeps) => Promise<WorkflowOutcome>,
): Promise<number> {
  const file = path.resolve(cwd, resultFile.replace(/^@/, ''));
  if (!fs.existsSync(file)) return usage(`native result bundle not found: ${resultFile}`);
  return withNative(cwd, { ...deps, runner: new NativeResultRunner(file) }, body);
}

function extractNativeResultsFlag(args: string[]): { resultFile: string | null; args: string[] } {
  const index = args.indexOf('--results');
  if (index < 0) return { resultFile: null, args };
  const resultFile = args[index + 1] ?? null;
  return {
    resultFile,
    args: args.filter((_, candidate) => candidate !== index && candidate !== index + 1),
  };
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
    console.log('rijo --watch: monitoring .rijo/runtime/status.json (Ctrl+C to stop)');
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
  const currentMilestone = activeMilestone(paths);
  const activePhase = currentMilestone && state?.phase
    ? readRoadmap(currentMilestone.paths.roadmap).phases.find((phase) => phase.id === state.phase)
    : null;
  const activePhaseDir = currentMilestone && activePhase
    ? path.relative(
        cwd,
        path.join(currentMilestone.paths.phasesDir, `${activePhase.id}-${activePhase.slug}`),
      ).split(path.sep).join('/')
    : null;

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
          active_phase_dir: activePhaseDir,
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
    console.log('[RIJO] Not initialized. Start with: $rijo new @PLAN.md');
    return 0;
  }
  console.log(`RIJO ${RIJO_VERSION} — active milestone: ${manifest.active_milestone ?? 'none'}`);
  for (const m of manifest.milestones) console.log(`  ${m.id}  ${m.slug}  ${m.status}`);
  if (status) console.log(`runtime: ${renderStatusLine(status)} (${status.status})`);
  if (state) {
    console.log(
      `checkpoint: milestone=${state.milestone ?? '—'} phase=${state.phase ?? '—'} stage=${state.stage ?? '—'}${state.blocked ? ` BLOCKED: ${state.blocked_reason}` : ''}`,
    );
    if (state.next_step) console.log(`next step: ${state.next_step}`);
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

const HELP = `RIJO — native software delivery workflow

Use \`$rijo\` in Codex or \`/rijo\` in Claude Code.

Commands:
  rijo map-codebase [--full] [--paths src/a,src/b] [--query "term"] [--status]
  rijo new @PLAN.md
  rijo ui @design.zip | @index.html | @dir/
  rijo start
  rijo test [--fix]
  rijo fix "problem description" [@evidence]
  rijo finish
  rijo next @NEXT-PLAN.md
  rijo status [--json]
  rijo resume
  rijo install [--codex] [--claude] [--project|--user]

Advanced compatibility:
  rijo map|run|check --host claude|codex
  rijo serve --stdio
  Host drivers can use codex exec adapters, claude -p adapters, or injected runners.
`;
