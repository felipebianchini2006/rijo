import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { exists, ensureDir, writeFileAtomic, readTextIfExists } from '../core/fsx.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { extractZipSafely, UnsafeZipError, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, type ZipInspection } from '../security/zip.js';
import { scanForMocks } from '../security/mockscan.js';
import { activeMilestone } from '../core/milestones.js';
import { touchManifest } from '../core/manifest.js';
import { readState, writeState, initialState } from '../core/state.js';
import type { AgentTaskDraft } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  dispatch,
  dispatchReadOnly,
  prepareAttempt,
  guardSchema,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';

export interface UiOptions {
  /** @design.zip, @index.html or @design-directory/ */
  input: string;
}

const MappingSchema = z.object({
  mappings: z
    .array(
      z.object({
        from: z.string(),
        to: z.string().min(1),
        kind: z.enum(['component', 'route', 'asset', 'api', 'state', 'style', 'test', 'config']),
        notes: z.string().default(''),
      }),
    )
    .min(1),
  routes: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  divergences: z.array(z.string()).default([]),
  states_covered: z.array(z.enum(['loading', 'empty', 'error', 'success'])).default([]),
});

/**
 * rijo ui — treat the design artifact as untrusted input and a visual
 * reference, not final architecture. Deterministic extraction + inventory,
 * agent-driven conversion to the target stack.
 */
export async function uiWorkflow(
  projectRoot: string,
  opts: UiOptions,
  deps: WorkflowDeps = {},
): Promise<WorkflowOutcome> {
  const ctx = createContext(projectRoot, deps);
  if (!exists(ctx.paths.manifest)) return failed(ctx, 'No RIJO project here. Run `rijo new @PLAN.md` first.');
  const schemaGuard = guardSchema(ctx);
  if (schemaGuard) return schemaGuard;
  return withLock(ctx, () => uiCore(ctx, opts));
}

/** Import a design using an existing context and lock (composes with `new`). */
export async function uiCore(ctx: WorkflowContext, opts: UiOptions): Promise<WorkflowOutcome> {
  const { projectRoot, paths, bus, now } = ctx;
  const inputPath = path.resolve(projectRoot, opts.input.replace(/^@/, ''));
  if (!exists(inputPath)) return failed(ctx, `Design input not found: ${opts.input}`);

  {
    const importId = now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12);
    const importDir = path.join(paths.importsDir, importId);
    const stagingDir = path.join(importDir, 'staging');
    ensureDir(importDir);

    // ---- 1-2: safe extraction, no script execution
    bus.emit('ui.extract', { status: 'running', stage: 'IMPORT', message: 'extraindo design com proteções' });
    let inspection: ZipInspection;
    try {
      if (inputPath.toLowerCase().endsWith('.zip')) {
        inspection = extractZipSafely(inputPath, stagingDir);
      } else if (fs.statSync(inputPath).isDirectory()) {
        ensureDir(stagingDir);
        inspection = copyDirectorySafely(inputPath, stagingDir);
      } else {
        const st = fs.lstatSync(inputPath);
        if (!st.isFile()) {
          return blocked(ctx, 'Design input rejected: not a regular file.', [opts.input]);
        }
        if (st.size > MAX_ENTRY_BYTES) {
          return blocked(ctx, `Design input rejected: file exceeds ${MAX_ENTRY_BYTES} bytes.`, [opts.input]);
        }
        ensureDir(stagingDir);
        fs.copyFileSync(inputPath, path.join(stagingDir, path.basename(inputPath)));
        inspection = { entries: [{ name: path.basename(inputPath), size: st.size }], warnings: [], executables: [], installScripts: [] };
      }
    } catch (err) {
      if (err instanceof UnsafeZipError) {
        return blocked(ctx, `Design archive rejected: ${err.message}`, ['The archive violates the safety policy (traversal/symlink/size/executable).']);
      }
      throw err;
    }

    // ---- 3: deterministic inventory
    bus.emit('ui.inventory', { stage: 'IMPORT', message: `inventariando ${inspection.entries.length} arquivos` });
    const invSummary = buildInventory(inspection);
    writeFileAtomic(
      path.join(importDir, 'INVENTORY.md'),
      serializeFrontmatter(
        { import_id: importId, source: path.basename(inputPath), files: inspection.entries.length, warnings: inspection.warnings },
        invSummary,
      ),
    );

    // ---- 5: detect target stack
    const stackNote = readTextIfExists(paths.stack) ?? '';
    const pkgRaw = readTextIfExists(path.join(projectRoot, 'package.json'));
    const targetHints: string[] = [];
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const all = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const known of ['next', 'react', 'vue', 'svelte', 'angular', 'typescript']) {
          if (all[known]) targetHints.push(`${known}@${all[known]}`);
        }
      } catch {
        /* ignore */
      }
    }

    // ---- mapping (READ-ONLY agent): the mapping is a validated payload the
    // CORE writes to disk — the agent never touches MAPPING.md itself.
    bus.emit('ui.convert', { stage: 'IMPORT', message: 'mapeando design para o stack do projeto (agente read-only)' });
    const mappingPath = path.join(importDir, 'MAPPING.md');
    const mapTask: AgentTaskDraft = {
      id: `ui-map-${importId}`,
      role: 'planner',
      objective: [
        'Map the imported design (visual reference, NOT final architecture) onto the target project stack.',
        'For every origin file decide the destination path (component/route/asset/api/state/style/test/config), deliberate divergences, and which UI states (loading, empty, error, success) each page must implement.',
        'Destinations must be exact project-relative paths — never globs, never .rijo, never node_modules.',
      ].join('\n'),
      canonical_files: [paths.rules, paths.stack].filter(exists),
      code_files: inspection.entries.slice(0, 50).map((e) => path.join(stagingDir, e.name)),
      write_scope: [],
      acceptance_criteria: ['Every relevant origin file has a destination', 'Routes and API contracts are mapped', 'All four UI states are planned'],
      verification_commands: [],
      return_format:
        'JSON payload: {mappings:[{from,to,kind:component|route|asset|api|state|style|test|config,notes}], routes:[{from,to}], divergences[], states_covered:[loading|empty|error|success]}',
      notes: `Target stack hints: ${targetHints.join(', ') || 'see STACK.md'}\n${stackNote.slice(0, 1500)}`,
    };
    const { result: mapRes, violation: mapViolation } = await dispatchReadOnly(ctx, mapTask);
    if (mapViolation.length > 0) {
      return blocked(ctx, 'UI mapping agent (read-only) modified the checkout.', mapViolation);
    }
    const mapping = MappingSchema.safeParse(mapRes.payload);
    if (!mapRes.ok || !mapping.success) {
      return blocked(ctx, 'UI mapping failed to produce a valid payload.', [mapRes.summary]);
    }

    // ---- write scope DERIVED from the mapping — never '**'
    const scopeIssues: string[] = [];
    const writeScope: string[] = [];
    for (const m of mapping.data.mappings) {
      const to = m.to.replace(/\\/g, '/');
      if (to.includes('*')) scopeIssues.push(`glob destination not allowed: ${to}`);
      else if (to.startsWith('.rijo') || to.startsWith('.git') || to.includes('node_modules')) scopeIssues.push(`forbidden destination: ${to}`);
      else if (path.isAbsolute(to) || to.startsWith('..')) scopeIssues.push(`destination escapes the project: ${to}`);
      else writeScope.push(to);
    }
    if (scopeIssues.length > 0) {
      return blocked(ctx, 'UI mapping produced an invalid write scope.', scopeIssues);
    }
    const requiredStates = ['loading', 'empty', 'error', 'success'] as const;
    const missingStates = requiredStates.filter((st) => !mapping.data.states_covered.includes(st));
    if (missingStates.length > 0) {
      return blocked(ctx, 'UI mapping does not plan all required UI states.', [
        `Missing states: ${missingStates.join(', ')} (loading, empty, error and success are mandatory).`,
      ]);
    }
    writeFileAtomic(
      mappingPath,
      serializeFrontmatter(
        { import_id: importId, states_covered: mapping.data.states_covered, routes: mapping.data.routes, divergences: mapping.data.divergences },
        [
          `# Mapping — import ${importId}`,
          '',
          '| Origin | Destination | Kind | Notes |',
          '|---|---|---|---|',
          ...mapping.data.mappings.map((m) => `| ${m.from} | ${m.to} | ${m.kind} | ${m.notes.replace(/\|/g, '\\|')} |`),
          '',
          '## Routes',
          ...(mapping.data.routes.length ? mapping.data.routes.map((r) => `- ${r.from} → ${r.to}`) : ['- none']),
          '',
          '## Deliberate divergences',
          ...(mapping.data.divergences.length ? mapping.data.divergences.map((d) => `- ${d}`) : ['- none']),
          '',
        ].join('\n'),
      ),
    );

    // ---- conversion in an ISOLATED workspace, bounded by the derived scope
    bus.emit('ui.convert_exec', { stage: 'IMPORT', message: `convertendo em workspace isolado (${writeScope.length} destinos)` });
    const convertTask: AgentTaskDraft = {
      id: `ui-convert-${importId}`,
      role: 'worker',
      objective: [
        'Convert the imported design into the target stack following MAPPING.md exactly.',
        'Native practices of the framework (routing, data fetching, forms, accessibility, error boundaries, loading/empty/error/success states).',
        'No iframes, no runtime dependency on the prototype, no copied bundles, NO mocks in the production path (typed contracts/ports for missing backends; fixtures only in tests).',
      ].join('\n'),
      canonical_files: [paths.rules, paths.stack, mappingPath].filter(exists),
      code_files: inspection.entries.slice(0, 50).map((e) => path.join(stagingDir, e.name)),
      write_scope: writeScope,
      acceptance_criteria: ['All mapped destinations implemented', 'No mock remains in the production path'],
      verification_commands: [],
      return_format: 'JSON payload: {converted: boolean, components_created[], notes}',
      notes: '',
    };
    const attempt = prepareAttempt(ctx, convertTask);
    let deltaFiles: string[] = [];
    try {
      const res = await dispatch(ctx, attempt.task);
      const conv = z.object({ converted: z.boolean(), components_created: z.array(z.string()).default([]), notes: z.string().default('') }).safeParse(res.payload);
      if (!res.ok || !conv.success || !conv.data.converted) {
        return blocked(ctx, 'UI conversion failed.', [res.summary]);
      }
      // real delta validated against the DERIVED scope (agent report ignored)
      const delta = attempt.workspace.validate();
      deltaFiles = delta.changed;
      if (deltaFiles.length === 0) {
        return blocked(ctx, 'UI conversion produced no changes.', []);
      }

      // ---- deterministic mock scan on the REAL changed files (payload is never proof)
      const mockFindings = scanForMocks(attempt.workspace.root, delta.added.concat(delta.modified));
      if (mockFindings.length > 0) {
        return blocked(
          ctx,
          'UI conversion left mocks/placeholders in the production path (deterministic scan).',
          mockFindings.slice(0, 15).map((f) => `${f.file}:${f.line} [${f.pattern}] ${f.excerpt}`),
        );
      }

      // ---- build + typecheck of the target stack, inside the workspace
      const pkg = pkgRaw ? (JSON.parse(pkgRaw) as { scripts?: Record<string, string> }) : null;
      const verifyScripts = ['typecheck', 'build'].filter((sc) => pkg?.scripts?.[sc]);
      if (!pkg || verifyScripts.length === 0) {
        return blocked(ctx, 'UI import requires a verifiable target stack.', [
          'The project must declare a build and/or typecheck script so the imported UI can be verified before applying.',
        ]);
      }
      for (const sc of verifyScripts) {
        const ev = ctx.shell.run(`npm run ${sc}`, { cwd: attempt.workspace.root });
        bus.emit('ui.verify', { message: `${sc} → exit ${ev.exit_code}` });
        if (ev.blocked || ev.exit_code !== 0) {
          return blocked(ctx, `UI import failed ${sc} in the isolated workspace.`, [ev.summary.slice(0, 600)]);
        }
      }

      // ---- REAL browser validation is mandatory when pages were imported
      const pagesImported = deltaFiles.some((f) => /\.(html?|tsx|jsx|vue|svelte)$/i.test(f));
      var validationNote = 'no pages imported (assets/config only); browser validation not required';
      if (pagesImported) {
        if (!ctx.runner.capabilities.browser) {
          return blocked(ctx, 'UI import with pages requires a real browser validation runtime.', [
            'The current runtime has no browser capability; run through a host with browser support (BLOCKED, never skipped).',
          ]);
        }
        bus.emit('ui.validate', { stage: 'UI_SMOKE', message: 'validação real: rotas, estados, viewports, console' });
        const validateTask: AgentTaskDraft = {
          id: `ui-validate-${importId}`,
          role: 'qa',
          objective:
            'Validate the converted UI in a real browser: every mapped route renders; loading, empty, error and success states behave; desktop/tablet/mobile viewports; keyboard and focus; console and network clean.',
          canonical_files: [mappingPath],
          code_files: deltaFiles.map((f) => path.join(attempt.workspace.root, f)),
          write_scope: [],
          acceptance_criteria: [
            'Every mapped route renders without console errors',
            'Loading, empty, error and success states verified',
            'No layout overflow on the three viewports',
          ],
          verification_commands: [],
          return_format: 'JSON payload: {passed: boolean, routes_checked[], states_checked[], notes}',
          notes: `Routes to validate: ${mapping.data.routes.map((r) => r.to).join(', ') || 'from MAPPING.md'}`,
        };
        const vres = await dispatch(ctx, { ...validateTask, workspace: { id: attempt.workspace.id, root: attempt.workspace.root } });
        const vparsed = z
          .object({ passed: z.boolean(), routes_checked: z.array(z.string()).default([]), states_checked: z.array(z.string()).default([]), notes: z.string().default('') })
          .safeParse(vres.payload);
        if (!vres.ok || !vparsed.success || !vparsed.data.passed) {
          return blocked(ctx, 'UI browser validation failed.', [vres.summary]);
        }
        validationNote = `browser validation passed (${vparsed.data.routes_checked.length} routes, states: ${vparsed.data.states_checked.join(', ') || 'reported ok'}): ${vparsed.data.notes}`;
      }

      // ---- ALL gates passed: only now the patch reaches the checkout
      attempt.workspace.applyVerifiedPatch();
    } catch (err) {
      if (err instanceof Error && ['WorkspaceScopeError', 'CanonicalWriteError', 'SymlinkEscapeError', 'PatchConflictError'].includes(err.name)) {
        return blocked(ctx, `UI conversion discarded — ${err.message}`, []);
      }
      throw err;
    } finally {
      attempt.workspace.discard();
    }
    const conv = { data: { components_created: deltaFiles, routes_mapped: mapping.data.routes, api_contracts: mapping.data.mappings.filter((m) => m.kind === 'api').map((m) => m.to), notes: '' } };

    // ---- 16-17: record origin/licenses + update state
    writeFileAtomic(
      path.join(importDir, 'IMPORT.md'),
      serializeFrontmatter(
        {
          import_id: importId,
          source: path.basename(inputPath),
          imported_at: now().toISOString(),
          components: conv.data.components_created,
          routes: conv.data.routes_mapped,
          api_contracts: conv.data.api_contracts,
          validation: validationNote,
        },
        [
          `# Import ${importId}`,
          '',
          `Source: ${path.basename(inputPath)} (treated as untrusted input).`,
          `Asset origin/licenses: verify before production; recorded warnings: ${inspection.warnings.join('; ') || 'none'}.`,
          '',
          conv.data.notes,
          '',
        ].join('\n'),
      ),
    );
    const milestone = activeMilestone(paths);
    const prev = readState(paths) ?? initialState(now);
    writeState(
      paths,
      { ...prev, milestone: milestone?.id ?? prev.milestone, next_step: 'rijo run', updated_at: now().toISOString() },
      `UI import ${importId} completed: ${conv.data.components_created.length} components, ${conv.data.routes_mapped.length} routes mapped. ${validationNote}`,
    );
    // STATE.md is hash-tracked: refresh the manifest so the next run does not
    // block on drift caused by RIJO's own state write.
    touchManifest(paths, () => {}, now);
    bus.emit('ui.done', { status: 'completed', message: `importação ${importId} concluída` });
    return completed(ctx, `UI import ${importId} done: ${conv.data.components_created.length} components, ${conv.data.routes_mapped.length} routes.`, [
      `Mapping: ${rel(projectRoot, mappingPath)}`,
      validationNote,
    ]);
  }
}

function buildInventory(inspection: ZipInspection): string {
  const byExt = new Map<string, number>();
  for (const e of inspection.entries) {
    const ext = path.extname(e.name).toLowerCase() || '(none)';
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const pages = inspection.entries.filter((e) => /\.(html?|tsx|jsx|vue|svelte)$/i.test(e.name));
  const assets = inspection.entries.filter((e) => /\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|eot)$/i.test(e.name));
  const data = inspection.entries.filter((e) => /\.(json|ya?ml)$/i.test(e.name));
  return [
    '# Design inventory',
    '',
    '## Pages / components',
    ...(pages.length ? pages.map((p) => `- ${p.name}`) : ['- none detected']),
    '',
    `## Assets (${assets.length})`,
    ...assets.slice(0, 50).map((a) => `- ${a.name}`),
    '',
    `## Data / mock candidates (${data.length})`,
    ...data.slice(0, 30).map((d) => `- ${d.name}`),
    '',
    '## File types',
    ...[...byExt.entries()].map(([ext, n]) => `- ${ext}: ${n}`),
    '',
    '## Safety warnings',
    ...(inspection.warnings.length ? inspection.warnings.map((w) => `- ${w}`) : ['- none']),
    '',
  ].join('\n');
}

function rel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

/** Zip-equivalent safety limits for directory inputs: entry count, per-file and
 *  total size, symlinks skipped, special files rejected. */
function copyDirectorySafely(from: string, to: string): ZipInspection {
  const inspection: ZipInspection = { entries: [], warnings: [], executables: [], installScripts: [] };
  let total = 0;
  const walk = (dir: string, relBase: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (inspection.entries.length >= MAX_ENTRIES) {
        throw new UnsafeZipError(`Directory has more than ${MAX_ENTRIES} entries`);
      }
      if (e.isSymbolicLink()) {
        inspection.warnings.push(`Symlink skipped: ${rel}`);
        continue;
      }
      if (e.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!e.isFile()) {
        throw new UnsafeZipError(`Special file in directory input: ${rel}`, rel);
      }
      const size = fs.statSync(full).size;
      if (size > MAX_ENTRY_BYTES) throw new UnsafeZipError(`File exceeds per-entry limit (${size} bytes): ${rel}`, rel);
      total += size;
      if (total > MAX_TOTAL_BYTES) throw new UnsafeZipError(`Directory exceeds total size limit (${MAX_TOTAL_BYTES} bytes)`);
      ensureDir(path.dirname(path.join(to, rel)));
      fs.copyFileSync(full, path.join(to, rel));
      inspection.entries.push({ name: rel, size });
    }
  };
  walk(from, '');
  return inspection;
}
