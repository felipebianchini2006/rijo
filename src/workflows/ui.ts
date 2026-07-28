import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  exists,
  ensureDir,
  readTextIfExists,
  sha256File,
  writeFileAtomic,
  writeJsonAtomic,
} from '../core/fsx.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { extractZipSafely, UnsafeZipError, MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, type ZipInspection } from '../security/zip.js';
import { scanForMocks } from '../security/mockscan.js';
import { activeMilestone } from '../core/milestones.js';
import { readRoadmap, renderRoadmap } from '../core/roadmap.js';
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
  commitDecisionProposals,
  replaceableAttempt,
  guardSchema,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';

export interface UiOptions {
  /** @design.zip, @index.html or @design-directory/ */
  input?: string;
  inputs?: string[];
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
  const inputArgs = opts.inputs ?? (opts.input ? [opts.input] : []);
  if (inputArgs.length === 0) return failed(ctx, 'At least one design input is required.');
  const inputPaths = inputArgs.map((input) =>
    path.resolve(projectRoot, input.replace(/^@/, '')),
  );
  const missingIndex = inputPaths.findIndex((inputPath) => !exists(inputPath));
  if (missingIndex >= 0) {
    return failed(ctx, `Design input not found: ${inputArgs[missingIndex]}`);
  }
  const linkedIndex = inputPaths.findIndex((inputPath) =>
    fs.lstatSync(inputPath).isSymbolicLink(),
  );
  if (linkedIndex >= 0) {
    return blocked(ctx, 'Design input rejected: the input root is a symbolic link.', [
      inputArgs[linkedIndex]!,
    ]);
  }
  const inputNames = inputPaths.map((inputPath) => path.basename(inputPath));

  {
    const importId = now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12);
    const importDir = path.join(paths.importsDir, importId);
    const stagingDir = path.join(importDir, 'staging');
    ensureDir(importDir);

    // ---- 1-2: safe extraction, no script execution
    bus.emit('ui.extract', { status: 'running', stage: 'IMPORT', message: 'Extract the design with safety controls.' });
    let inspection: ZipInspection;
    try {
      inspection = mergeDesignInputs(inputPaths, importDir, stagingDir);
    } catch (err) {
      if (err instanceof UnsafeZipError) {
        return blocked(ctx, `Design archive rejected: ${err.message}`, ['The archive violates the safety policy (traversal/symlink/size/executable).']);
      }
      throw err;
    }

    // ---- 3: deterministic inventory
    bus.emit('ui.inventory', { stage: 'IMPORT', message: `Inventory ${inspection.entries.length} files.` });
    const invSummary = buildInventory(inspection);
    writeFileAtomic(
      path.join(importDir, 'INVENTORY.md'),
      serializeFrontmatter(
        {
          import_id: importId,
          sources: inputNames,
          primary_html: findPrimaryHtml(inspection),
          files: inspection.entries.length,
          warnings: inspection.warnings,
        },
        invSummary,
      ),
    );
    const artifactManifest = path.join(importDir, 'ARTIFACTS.json');
    writeJsonAtomic(artifactManifest, {
      schema_version: 1,
      primary_html: findPrimaryHtml(inspection),
      artifacts: inspection.entries
        .filter((entry) => isBinaryAsset(entry.name))
        .map((entry) => ({
          staged_path: path
            .relative(importDir, path.join(stagingDir, entry.name))
            .split(path.sep)
            .join('/'),
          sha256: sha256File(path.join(stagingDir, entry.name)),
          size: entry.size,
          media_type: mediaType(entry.name),
        })),
    });
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
    bus.emit('ui.convert', { stage: 'IMPORT', message: 'Map the design to the project stack with a read-only agent.' });
    const mappingPath = path.join(importDir, 'MAPPING.md');
    const mapTask: AgentTaskDraft = {
      id: `ui-map-${importId}`,
      role: 'planner',
      objective: [
        'Map the imported design (visual reference, NOT final architecture) onto the target project stack.',
        'For every origin file decide the destination path (component/route/asset/api/state/style/test/config), deliberate divergences, and which UI states (loading, empty, error, success) each page must implement.',
        'Destinations must be exact project-relative paths — never globs, never .rijo, never node_modules.',
      ].join('\n'),
      canonical_files: [paths.rules, paths.stack, artifactManifest].filter(exists),
      code_files: inspection.entries
        .filter((entry) => !isBinaryAsset(entry.name))
        .slice(0, 50)
        .map((entry) => path.join(stagingDir, entry.name)),
      write_scope: [],
      acceptance_criteria: ['Every relevant origin file has a destination', 'Routes and API contracts are mapped', 'All four UI states are planned'],
      verification_commands: [],
      return_format:
        'JSON payload: {mappings:[{from,to,kind:component|route|asset|api|state|style|test|config,notes}], routes:[{from,to}], divergences[], states_covered:[loading|empty|error|success]}',
      notes: `Target stack hints: ${targetHints.join(', ') || 'see STACK.md'}\n${stackNote.slice(0, 1500)}`,
    };
    const { result: mapRes, violation: mapViolation } = await dispatchReadOnly(ctx, mapTask, { stage: 'UI_SMOKE' });
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
    commitDecisionProposals(ctx, mapRes);

    // ---- conversion in an ISOLATED workspace, bounded by the derived scope
    bus.emit('ui.convert_exec', { stage: 'IMPORT', message: `Convert in an isolated workspace (${writeScope.length} destinations).` });
    const convertTask: AgentTaskDraft = {
      id: `ui-convert-${importId}`,
      role: 'worker',
      objective: [
        'Convert the imported design into the target stack following MAPPING.md exactly.',
        'Native practices of the framework (routing, data fetching, forms, accessibility, error boundaries, loading/empty/error/success states).',
        'No iframes, no runtime dependency on the prototype, no copied bundles, NO mocks in the production path (typed contracts/ports for missing backends; fixtures only in tests).',
      ].join('\n'),
      canonical_files: [paths.rules, paths.stack, mappingPath, artifactManifest].filter(exists),
      code_files: inspection.entries
        .filter((entry) => !isBinaryAsset(entry.name))
        .slice(0, 50)
        .map((entry) => path.join(stagingDir, entry.name)),
      write_scope: writeScope,
      acceptance_criteria: ['All mapped destinations implemented', 'No mock remains in the production path'],
      verification_commands: [],
      return_format: 'JSON payload: {converted: boolean, components_created[], notes}',
      notes: '',
    };
    const attemptH = replaceableAttempt(ctx, convertTask, {}, { stage: 'UI_SMOKE' });
    let deltaFiles: string[] = [];
    let conversionEnvelope: import('./shared.js').ValidatedAgentEnvelope | null = null;
    let validationEnvelope: import('./shared.js').ValidatedAgentEnvelope | null = null;
    try {
      const res = await dispatch(ctx, attemptH.attempt.task, { stage: 'UI_SMOKE' }, { prepareReplacement: attemptH.prepareReplacement });
      conversionEnvelope = res;
      const conv = z.object({ converted: z.boolean(), components_created: z.array(z.string()).default([]), notes: z.string().default('') }).safeParse(res.payload);
      if (!res.ok || !conv.success || !conv.data.converted) {
        return blocked(ctx, 'UI conversion failed.', [res.summary]);
      }
      // real delta validated against the DERIVED scope (agent report ignored)
      const delta = attemptH.attempt.workspace.validate();
      deltaFiles = delta.changed;
      if (deltaFiles.length === 0) {
        return blocked(ctx, 'UI conversion produced no changes.', []);
      }

      // ---- deterministic mock scan on the REAL changed files (payload is never proof)
      const mockFindings = scanForMocks(attemptH.attempt.workspace.root, delta.added.concat(delta.modified));
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
        const ev = ctx.shell.run(`npm run ${sc}`, { cwd: attemptH.attempt.workspace.root });
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
        bus.emit('ui.validate', { stage: 'UI_SMOKE', message: 'Validate routes, states, viewports, and the console.' });
        const validateTask: AgentTaskDraft = {
          id: `ui-validate-${importId}`,
          role: 'qa',
          objective:
            'Validate the converted UI in a real browser: every mapped route renders; loading, empty, error and success states behave; desktop/tablet/mobile viewports; keyboard and focus; console and network clean.',
          canonical_files: [mappingPath],
          code_files: deltaFiles.map((f) => path.join(attemptH.attempt.workspace.root, f)),
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
        const vres = await dispatch(ctx, { ...validateTask, workspace: { id: attemptH.attempt.workspace.id, root: attemptH.attempt.workspace.root } }, { stage: 'UI_SMOKE' });
        validationEnvelope = vres;
        const vparsed = z
          .object({ passed: z.boolean(), routes_checked: z.array(z.string()).default([]), states_checked: z.array(z.string()).default([]), notes: z.string().default('') })
          .safeParse(vres.payload);
        if (!vres.ok || !vparsed.success || !vparsed.data.passed) {
          return blocked(ctx, 'UI browser validation failed.', [vres.summary]);
        }
        validationNote = `browser validation passed (${vparsed.data.routes_checked.length} routes, states: ${vparsed.data.states_checked.join(', ') || 'reported ok'}): ${vparsed.data.notes}`;
      }

      // ---- ALL gates passed: only now the patch reaches the checkout
      attemptH.attempt.workspace.applyVerifiedPatch();
      if (validationEnvelope) commitDecisionProposals(ctx, validationEnvelope);
      if (conversionEnvelope) commitDecisionProposals(ctx, conversionEnvelope);
    } catch (err) {
      if (err instanceof Error && ['WorkspaceScopeError', 'CanonicalWriteError', 'SymlinkEscapeError', 'PatchConflictError'].includes(err.name)) {
        return blocked(ctx, `UI conversion discarded — ${err.message}`, []);
      }
      throw err;
    } finally {
      attemptH.attempt.workspace.discard();
    }
    const conv = { data: { components_created: deltaFiles, routes_mapped: mapping.data.routes, api_contracts: mapping.data.mappings.filter((m) => m.kind === 'api').map((m) => m.to), notes: '' } };

    // ---- 16-17: record origin/licenses + update state
    writeFileAtomic(
      path.join(importDir, 'VISUAL-COMPARISON.md'),
      [
        `# Visual comparison — import ${importId}`,
        '',
        `Primary source: ${findPrimaryHtml(inspection) ?? 'not detected'}`,
        'Viewports: desktop, tablet, mobile',
        `Result: ${validationNote}`,
        '',
        '## Intentional divergences',
        ...(mapping.data.divergences.length
          ? mapping.data.divergences.map((divergence) => `- ${divergence}`)
          : ['- none']),
        '',
      ].join('\n'),
    );
    writeFileAtomic(
      path.join(importDir, 'IMPORT.md'),
      serializeFrontmatter(
        {
          import_id: importId,
          sources: inputNames,
          imported_at: now().toISOString(),
          components: conv.data.components_created,
          routes: conv.data.routes_mapped,
          api_contracts: conv.data.api_contracts,
          validation: validationNote,
        },
        [
          `# Import ${importId}`,
          '',
          `Sources: ${inputNames.join(', ')} (treated as untrusted input).`,
          `Asset origin/licenses: verify before production; recorded warnings: ${inspection.warnings.join('; ') || 'none'}.`,
          '',
          conv.data.notes,
          '',
        ].join('\n'),
      ),
    );
    const milestone = activeMilestone(paths);
    if (milestone && exists(milestone.paths.roadmap)) {
      const roadmap = readRoadmap(milestone.paths.roadmap);
      const affected =
        roadmap.phases.find((phase) => phase.status !== 'DONE' && phase.ui_surface) ??
        roadmap.phases.find((phase) => phase.status !== 'DONE');
      if (affected) {
        affected.ui_surface = true;
        writeFileAtomic(milestone.paths.roadmap, renderRoadmap(roadmap));
      }
    }
    const prev = readState(paths) ?? initialState(now);
    writeState(
      paths,
      { ...prev, milestone: milestone?.id ?? prev.milestone, next_step: '$rijo start', updated_at: now().toISOString() },
      `UI import ${importId} completed: ${conv.data.components_created.length} components, ${conv.data.routes_mapped.length} routes mapped. ${validationNote}`,
    );
    // STATE.md is hash-tracked: refresh the manifest so the next run does not
    // block on drift caused by RIJO's own state write.
    touchManifest(paths, () => {}, now);
    bus.emit('ui.done', { status: 'completed', message: `Completed design import ${importId}.` });
    return completed(ctx, `UI import ${importId} done: ${conv.data.components_created.length} components, ${conv.data.routes_mapped.length} routes.`, [
      `Mapping: ${rel(projectRoot, mappingPath)}`,
      validationNote,
    ]);
  }
}

function mergeDesignInputs(
  inputPaths: string[],
  importDir: string,
  stagingDir: string,
): ZipInspection {
  const sourceStaging = path.join(importDir, '.source-staging');
  ensureDir(sourceStaging);
  ensureDir(stagingDir);
  const merged: ZipInspection = {
    entries: [],
    warnings: [],
    executables: [],
    installScripts: [],
  };
  const paths = new Map<string, string>();
  const hashes = new Map<string, string>();
  let total = 0;
  try {
    for (let index = 0; index < inputPaths.length; index++) {
      const inputPath = inputPaths[index]!;
      const sourceDir = path.join(sourceStaging, String(index + 1));
      ensureDir(sourceDir);
      let inspection: ZipInspection;
      if (inputPath.toLowerCase().endsWith('.zip')) {
        inspection = extractZipSafely(inputPath, sourceDir);
      } else if (fs.lstatSync(inputPath).isDirectory()) {
        inspection = copyDirectorySafely(inputPath, sourceDir);
      } else {
        const stat = fs.lstatSync(inputPath);
        if (!stat.isFile()) throw new UnsafeZipError('Design input is not a regular file.');
        if (stat.size > MAX_ENTRY_BYTES) {
          throw new UnsafeZipError(`Design input exceeds ${MAX_ENTRY_BYTES} bytes.`);
        }
        const name = path.basename(inputPath);
        fs.copyFileSync(inputPath, path.join(sourceDir, name));
        inspection = {
          entries: [{ name, size: stat.size }],
          warnings: [],
          executables: [],
          installScripts: [],
        };
      }
      merged.warnings.push(
        ...inspection.warnings.map((warning) => `${path.basename(inputPath)}: ${warning}`),
      );
      merged.executables.push(...inspection.executables);
      merged.installScripts.push(...inspection.installScripts);
      for (const entry of inspection.entries) {
        const normalized = entry.name.replace(/\\/g, '/');
        const source = path.join(sourceDir, normalized);
        const hash = sha256File(source);
        const existingHash = paths.get(normalized);
        if (existingHash && existingHash !== hash) {
          throw new UnsafeZipError(
            `Path collision has different content: ${normalized}`,
            normalized,
          );
        }
        if (existingHash) continue;
        total += entry.size;
        if (total > MAX_TOTAL_BYTES) {
          throw new UnsafeZipError(`Combined design inputs exceed ${MAX_TOTAL_BYTES} bytes.`);
        }
        const target = path.join(stagingDir, normalized);
        ensureDir(path.dirname(target));
        const canonical = hashes.get(hash);
        if (canonical) {
          try {
            fs.linkSync(canonical, target);
          } catch {
            fs.copyFileSync(canonical, target);
          }
        } else {
          fs.copyFileSync(source, target);
          hashes.set(hash, target);
        }
        paths.set(normalized, hash);
        merged.entries.push({ name: normalized, size: entry.size });
      }
    }
  } finally {
    fs.rmSync(sourceStaging, { recursive: true, force: true });
  }
  return merged;
}

function findPrimaryHtml(inspection: ZipInspection): string | null {
  const html = inspection.entries
    .map((entry) => entry.name)
    .filter((name) => /\.html?$/i.test(name))
    .sort((left, right) => {
      const leftIndex = /(^|\/)index\.html?$/i.test(left) ? 0 : 1;
      const rightIndex = /(^|\/)index\.html?$/i.test(right) ? 0 : 1;
      return leftIndex - rightIndex || left.localeCompare(right);
    });
  return html[0] ?? null;
}

function isBinaryAsset(file: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|mp4|webm|mov|mp3|wav)$/i.test(
    file,
  );
}

function mediaType(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
    }[extension] ?? 'application/octet-stream'
  );
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
  const sourceRoot = fs.realpathSync(from);
  let total = 0;
  const walk = (dir: string, relBase: string) => {
    const realDirectory = fs.realpathSync(dir);
    const relativeDirectory = path.relative(sourceRoot, realDirectory);
    if (
      relativeDirectory === '..' ||
      relativeDirectory.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeDirectory)
    ) {
      throw new UnsafeZipError(`Directory leaves the design root: ${relBase || '.'}`);
    }
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
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      let fd: number;
      try {
        fd = fs.openSync(full, flags);
      } catch {
        throw new UnsafeZipError(`File could not be opened without following links: ${rel}`, rel);
      }
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
          throw new UnsafeZipError(`Special file in directory input: ${rel}`, rel);
        }
        const size = stat.size;
        if (size > MAX_ENTRY_BYTES) {
          throw new UnsafeZipError(`File exceeds per-entry limit (${size} bytes): ${rel}`, rel);
        }
        total += size;
        if (total > MAX_TOTAL_BYTES) {
          throw new UnsafeZipError(`Directory exceeds total size limit (${MAX_TOTAL_BYTES} bytes)`);
        }
        ensureDir(path.dirname(path.join(to, rel)));
        fs.writeFileSync(path.join(to, rel), fs.readFileSync(fd));
        inspection.entries.push({ name: rel, size });
      } finally {
        fs.closeSync(fd);
      }
    }
  };
  walk(from, '');
  return inspection;
}
