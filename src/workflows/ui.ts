import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { exists, ensureDir, writeFileAtomic, inventory, readTextIfExists } from '../core/fsx.js';
import { serializeFrontmatter } from '../core/frontmatter.js';
import { extractZipSafely, UnsafeZipError, type ZipInspection } from '../security/zip.js';
import { activeMilestone } from '../core/milestones.js';
import { touchManifest } from '../core/manifest.js';
import { readState, writeState, initialState } from '../core/state.js';
import type { AgentTask } from '../agents/protocol.js';
import {
  createContext,
  withLock,
  blocked,
  completed,
  failed,
  dispatch,
  guardSchema,
  type WorkflowContext,
  type WorkflowDeps,
  type WorkflowOutcome,
} from './shared.js';

export interface UiOptions {
  /** @design.zip, @index.html or @design-directory/ */
  input: string;
}

const ConversionSchema = z.object({
  converted: z.boolean(),
  components_created: z.array(z.string()).default([]),
  routes_mapped: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  mocks_removed: z.array(z.string()).default([]),
  remaining_mocks: z.array(z.string()).default([]),
  api_contracts: z.array(z.string()).default([]),
  notes: z.string().default(''),
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
        fs.cpSync(inputPath, stagingDir, { recursive: true, dereference: false, filter: (src) => !fs.lstatSync(src).isSymbolicLink() });
        inspection = { entries: inventory(stagingDir).map((f) => ({ name: f.relPath, size: f.size })), warnings: [], executables: [], installScripts: [] };
      } else {
        ensureDir(stagingDir);
        fs.copyFileSync(inputPath, path.join(stagingDir, path.basename(inputPath)));
        inspection = { entries: [{ name: path.basename(inputPath), size: fs.statSync(inputPath).size }], warnings: [], executables: [], installScripts: [] };
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

    // ---- 6-14: agent-driven mapping + conversion
    bus.emit('ui.convert', { stage: 'IMPORT', message: 'mapeando e convertendo para o stack do projeto' });
    const mappingPath = path.join(importDir, 'MAPPING.md');
    const convertTask: AgentTask = {
      id: `ui-convert-${importId}`,
      role: 'worker',
      objective: [
        'Convert the imported design (visual reference, NOT final architecture) into the target project stack.',
        `1. Write ${rel(projectRoot, mappingPath)}: origin file → destination component/route/state/API/asset, deliberate divergences, visual-equivalence criteria.`,
        '2. Convert to the target language/framework following its native practices (routing, server/client split, data fetching, forms, metadata, images, accessibility, error boundaries, loading/empty states).',
        '3. No iframes, no runtime dependency on the prototype, no copied bundles.',
        '4. Remove mocks from the production path; create typed interfaces/clients for real APIs; when the backend does not exist yet, create explicit contracts and ports (fixtures only in tests).',
        '5. Preserve visual fidelity without perpetuating bad technical decisions.',
      ].join('\n'),
      canonical_files: [paths.rules, paths.stack].filter(exists),
      code_files: inspection.entries.slice(0, 50).map((e) => path.join(stagingDir, e.name)),
      write_scope: ['**'],
      acceptance_criteria: [
        'MAPPING.md exists with origin→destination table',
        'No mock remains in the production path',
        'Routes and APIs are mapped',
      ],
      verification_commands: [],
      return_format:
        'JSON payload: {converted, components_created[], routes_mapped[{from,to}], mocks_removed[], remaining_mocks[], api_contracts[], notes}',
      notes: `Target stack hints: ${targetHints.join(', ') || 'see STACK.md'}\n${stackNote.slice(0, 1500)}`,
    };
    const res = await dispatch(ctx, convertTask);
    const conv = ConversionSchema.safeParse(res.payload);
    if (!res.ok || !conv.success || !conv.data.converted) {
      return blocked(ctx, 'UI conversion failed.', [res.summary]);
    }
    if (conv.data.remaining_mocks.length > 0) {
      return blocked(ctx, 'UI conversion left mocks in the production path.', conv.data.remaining_mocks);
    }
    if (!exists(mappingPath)) {
      return blocked(ctx, 'UI conversion did not produce MAPPING.md.', ['The mapping file is mandatory for traceability.']);
    }

    // ---- 15: validation (browser when available; honest otherwise)
    let validationNote = 'browser validation SKIPPED: capability unavailable (recorded, not simulated)';
    if (ctx.runner.capabilities.browser) {
      bus.emit('ui.validate', { stage: 'UI_SMOKE', message: 'validando desktop/tablet/mobile, a11y, console' });
      const validateTask: AgentTask = {
        id: `ui-validate-${importId}`,
        role: 'qa',
        objective:
          'Validate the imported UI: desktop/tablet/mobile viewports, keyboard and focus, semantics/accessibility, overflow/clipping, typography/spacing, console and network, comparative screenshots.',
        canonical_files: [mappingPath],
        code_files: [],
        write_scope: [path.join(importDir, 'validation').replace(/\\/g, '/') + '/**'],
        acceptance_criteria: ['No console errors on main routes', 'No layout overflow on the three viewports'],
        verification_commands: [],
        return_format: 'JSON payload: {passed: boolean, notes: string}',
        notes: '',
      };
      const vres = await dispatch(ctx, validateTask);
      const vparsed = z.object({ passed: z.boolean(), notes: z.string().default('') }).safeParse(vres.payload);
      if (!vres.ok || !vparsed.success || !vparsed.data.passed) {
        return blocked(ctx, 'UI validation failed.', [vres.summary]);
      }
      validationNote = `browser validation passed: ${vparsed.data.notes}`;
    }

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
