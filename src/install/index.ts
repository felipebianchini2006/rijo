import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClaude, generateClaudeAdapter } from '../adapters/claude.js';
import { detectCodex, generateCodexAdapter } from '../adapters/codex.js';
import type { AdapterReport } from '../adapters/shared.js';
import {
  assertContainedWithoutSymlinks,
  ensureDir,
  exists,
  readJsonIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} from '../core/fsx.js';
import { RIJO_VERSION } from '../core/manifest.js';

export type InstallHost = 'codex' | 'claude';
export type InstallScope = 'project' | 'user';

export interface InstallOptions {
  /** Repository root for project scope, or home directory for user scope. */
  root: string;
  /** Explicit hosts. Omit this field to detect installed hosts. */
  hosts?: readonly InstallHost[];
  /** Installation scope. The default is `project`. */
  scope?: InstallScope;
}

export interface ProjectBinding {
  projectRoot: string;
  toolingRoot: string;
  isolated: boolean;
  version: string;
  manifest: string;
  lockfile: string;
  launcher: string;
  managedPaths: ProjectManagedPath[];
}

export interface ProjectManagedPath {
  path: string;
  created_by_rijo: boolean;
}

export interface ProjectDependencyInstallOptions {
  /** Explicit package source. The default is the package that runs this code. */
  packageSpec?: string;
}

export interface InstallReport extends AdapterReport {
  root: string;
  scope: InstallScope;
  hosts: InstallHost[];
  binding: ProjectBinding | null;
}

/**
 * Install the native RIJO skill and provider files.
 *
 * This API does not require `.rijo/` or a package project. Repeated calls
 * produce the same files and preserve content outside RIJO marker blocks.
 */
export function installRijo(options: InstallOptions): InstallReport {
  const root = path.resolve(options.root);
  const scope = options.scope ?? 'project';
  const hosts = normalizeHosts(options.hosts ?? detectInstalledHosts(root, scope));
  const report: InstallReport = {
    root,
    scope,
    hosts,
    generated: [],
    skipped: [],
    notes: [],
    binding: null,
  };

  if (scope === 'project') {
    report.binding = prepareProjectBinding(root);
    report.generated.push(
      relative(root, report.binding.manifest),
      relative(root, report.binding.launcher),
    );
  }

  const merge = (adapter: AdapterReport): void => {
    report.generated.push(...adapter.generated);
    report.skipped.push(...adapter.skipped);
    report.notes.push(...adapter.notes);
  };

  for (const host of hosts) {
    if (host === 'codex') merge(generateCodexAdapter(root, { scope }));
    if (host === 'claude') merge(generateClaudeAdapter(root, { scope }));
  }

  if (hosts.length === 0) {
    report.notes.push('No installed Codex or Claude Code host was detected. Use an explicit host flag.');
  }
  return report;
}

/**
 * Create the deterministic project binding without network access.
 *
 * The CLI follows this step with installProjectDependency. Keeping preparation
 * separate makes provider generation and idempotency tests deterministic.
 */
export function prepareProjectBinding(projectRootInput: string): ProjectBinding {
  const projectRoot = path.resolve(projectRootInput);
  ensureDir(projectRoot);
  const isolated = usesNonNpmApplicationManager(projectRoot);
  const toolingRoot = isolated ? path.join(projectRoot, '.rijo', 'tooling') : projectRoot;
  const manifest = path.join(toolingRoot, 'package.json');
  const lockfile = path.join(toolingRoot, 'package-lock.json');
  const packageArchive = path.join(
    projectRoot,
    '.rijo',
    'tooling',
    `rijo-${RIJO_VERSION}.tgz`,
  );
  const launcher = path.join(projectRoot, '.rijo', 'bin', 'rijo.cjs');
  const ignore = path.join(projectRoot, '.gitignore');
  const bindingFile = path.join(projectRoot, '.rijo', 'tooling-binding.json');
  const priorBinding = readJsonIfExists<{
    managed_paths?: ProjectManagedPath[];
  }>(bindingFile);
  const priorOwnership = new Map(
    (priorBinding?.managed_paths ?? []).map((entry) => [entry.path, entry.created_by_rijo]),
  );
  const managedPaths = [manifest, lockfile, ignore, packageArchive].map((target) => {
    const relativePath = relative(projectRoot, target);
    return {
      path: relativePath,
      created_by_rijo: priorOwnership.get(relativePath) ?? !exists(target),
    };
  });
  for (const target of [toolingRoot, manifest, lockfile, launcher, packageArchive]) {
    assertContainedWithoutSymlinks(projectRoot, target);
  }
  ensureDir(toolingRoot);
  updateProjectIgnore(projectRoot, isolated);
  const current = readJsonIfExists<Record<string, unknown>>(manifest) ?? {};
  const devDependencies =
    current['devDependencies'] && typeof current['devDependencies'] === 'object'
      ? { ...(current['devDependencies'] as Record<string, unknown>) }
      : {};
  devDependencies['rijo'] = RIJO_VERSION;
  writeJsonAtomic(manifest, {
    ...(Object.keys(current).length > 0
      ? current
      : {
          name: isolated ? 'rijo-project-tooling' : path.basename(projectRoot),
          private: true,
          version: '0.0.0',
        }),
    private: current['private'] ?? true,
    devDependencies,
  });
  writeFileAtomic(
    launcher,
    renderProjectLauncher({
      expectedVersion: RIJO_VERSION,
      toolingRootRelative: path.relative(path.dirname(launcher), toolingRoot),
    }),
  );
  writeJsonAtomic(bindingFile, {
    schema_version: 1,
    rijo_version: RIJO_VERSION,
    isolated,
    tooling_root: path.relative(projectRoot, toolingRoot) || '.',
    manifest: path.relative(projectRoot, manifest),
    lockfile: path.relative(projectRoot, lockfile),
    launcher: path.relative(projectRoot, launcher),
    managed_paths: managedPaths,
  });
  return {
    projectRoot,
    toolingRoot,
    isolated,
    version: RIJO_VERSION,
    manifest,
    lockfile,
    launcher,
    managedPaths,
  };
}

function updateProjectIgnore(projectRoot: string, isolated: boolean): void {
  const file = path.join(projectRoot, '.gitignore');
  const begin = '# RIJO:BEGIN';
  const end = '# RIJO:END';
  const body = [
    begin,
    isolated ? '.rijo/tooling/node_modules/' : 'node_modules/',
    '.rijo/runtime/',
    end,
  ].join('\n');
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : '';
  const start = current.indexOf(begin);
  const finish = current.indexOf(end);
  const updated =
    start >= 0 && finish > start
      ? `${current.slice(0, start)}${body}${current.slice(finish + end.length)}`
      : current.trim().length === 0
        ? `${body}\n`
        : `${current.trimEnd()}\n\n${body}\n`;
  writeFileAtomic(file, updated);
}

/** Install the exact project dependency and produce or update its npm lockfile. */
export function installProjectDependency(
  projectRoot: string,
  options: ProjectDependencyInstallOptions = {},
): ProjectBinding {
  const binding = prepareProjectBinding(projectRoot);

  // A repeated local installation already has the required package materialized.
  // Do not ask npm to install a package from its own node_modules destination.
  if (options.packageSpec === undefined) {
    try {
      validateInstalledBinding(binding);
      return binding;
    } catch {
      // Continue and repair the project binding from the running package.
    }
  }

  const packageSource = options.packageSpec ?? resolveRunningPackageRoot(binding.version);
  const packageSpec = materializePortablePackageArchive(binding, packageSource);
  const result = spawnSync(
    'npm',
    [
      'install',
      '--save-dev',
      '--save-exact',
      '--install-links',
      '--no-audit',
      '--no-fund',
      packageSpec,
    ],
    {
      cwd: binding.toolingRoot,
      env: npmChildEnvironment(binding.toolingRoot),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5 * 60_000,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `The project-local RIJO installation failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  // A local package spec is used by clean tarball tests. Keep the public
  // manifest and the lock root pinned to the exact semantic version.
  pinManifestAndLock(binding);
  validateInstalledBinding(binding);
  return binding;
}

/**
 * Put the exact package bytes under project control before npm writes the lock.
 *
 * An npm/npx cache path is machine-local. A lockfile that points at that path
 * cannot support npm ci in a clean clone. The project archive keeps an
 * unpublished release candidate portable without changing the public semantic
 * version pin in package.json.
 */
function materializePortablePackageArchive(
  binding: ProjectBinding,
  packageSource: string,
): string {
  const source = path.resolve(packageSource);
  if (!exists(source)) return packageSource;

  const archiveDirectory = path.join(binding.projectRoot, '.rijo', 'tooling');
  const archive = path.join(archiveDirectory, `rijo-${binding.version}.tgz`);
  ensureDir(archiveDirectory);

  if (fs.statSync(source).isFile()) {
    if (path.resolve(source) !== path.resolve(archive)) fs.copyFileSync(source, archive);
    return portableArchiveSpec(binding, archive);
  }

  const packed = spawnSync(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--pack-destination',
      archiveDirectory,
      source,
    ],
    {
      cwd: binding.projectRoot,
      env: npmChildEnvironment(binding.projectRoot),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5 * 60_000,
    },
  );
  if (packed.status !== 0) {
    throw new Error(
      `The portable RIJO package archive failed: ${(packed.stderr || packed.stdout).trim()}`,
    );
  }
  const produced = path.join(
    archiveDirectory,
    packed.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '',
  );
  if (!exists(produced)) {
    throw new Error('npm pack did not produce the portable RIJO package archive.');
  }
  if (path.resolve(produced) !== path.resolve(archive)) {
    fs.renameSync(produced, archive);
  }
  return portableArchiveSpec(binding, archive);
}

function portableArchiveSpec(binding: ProjectBinding, archive: string): string {
  const relativeArchive = path.relative(binding.toolingRoot, archive).split(path.sep).join('/');
  return relativeArchive.startsWith('.') ? relativeArchive : `./${relativeArchive}`;
}

function npmChildEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['npm_config_local_prefix'];
  delete env['INIT_CWD'];
  env['PWD'] = cwd;
  return env;
}

/**
 * Find the package that contains the running installer.
 *
 * This source is available for global installs, npx cache installs, packed
 * tarballs, and project-local installs. It lets an unpublished exact version
 * bootstrap a project without a registry lookup.
 */
function resolveRunningPackageRoot(expectedVersion: string): string {
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = readJsonIfExists<{ name?: string; version?: string }>(
      path.join(candidate, 'package.json'),
    );
    if (manifest?.name === 'rijo') {
      if (manifest.version !== expectedVersion) {
        throw new Error(
          `The running RIJO package has version ${manifest.version ?? 'unknown'}, but the installer expects ${expectedVersion}.`,
        );
      }
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error('The running RIJO package root could not be found.');
    }
    candidate = parent;
  }
}

export function validateInstalledBinding(binding: ProjectBinding): void {
  const manifest = readJsonIfExists<{
    devDependencies?: Record<string, string>;
  }>(binding.manifest);
  const lock = readJsonIfExists<{
    packages?: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
  }>(binding.lockfile);
  const installed = readJsonIfExists<{ version?: string }>(
    path.join(binding.toolingRoot, 'node_modules', 'rijo', 'package.json'),
  );
  const errors: string[] = [];
  if (manifest?.devDependencies?.['rijo'] !== binding.version) {
    errors.push(`package.json requires ${manifest?.devDependencies?.['rijo'] ?? 'no RIJO version'}`);
  }
  if (lock?.packages?.['']?.devDependencies?.['rijo'] !== binding.version) {
    errors.push('package-lock.json does not pin the expected RIJO version');
  }
  if (lock?.packages?.['node_modules/rijo']?.version !== binding.version) {
    errors.push(`package-lock.json resolved ${lock?.packages?.['node_modules/rijo']?.version ?? 'no RIJO package'}`);
  }
  if (installed?.version !== binding.version) {
    errors.push(`node_modules contains ${installed?.version ?? 'no RIJO package'}`);
  }
  if (errors.length > 0) {
    throw new Error(`RIJO project binding mismatch. ${errors.join('. ')}.`);
  }
}

/** Detect provider installations without starting a host process. */
export function detectInstalledHosts(root: string, scope: InstallScope = 'project'): InstallHost[] {
  const detected = new Set<InstallHost>();
  if (detectCodex(root) || exists(path.join(root, '.agents')) || commandExists('codex')) detected.add('codex');
  if (
    detectClaude(root) ||
    exists(path.join(root, '.claude')) ||
    process.env['CLAUDECODE'] === '1' ||
    commandExists('claude')
  ) {
    detected.add('claude');
  }

  // Scope changes target paths, not host detection rules. Keep this argument
  // explicit so callers cannot confuse a project root with a home directory.
  void scope;
  return [...detected].sort();
}

function normalizeHosts(hosts: readonly InstallHost[]): InstallHost[] {
  return [...new Set(hosts)].sort();
}

function commandExists(command: string): boolean {
  const executable = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(executable, [command], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 2_000,
  });
  return result.status === 0;
}

function usesNonNpmApplicationManager(root: string): boolean {
  if (exists(path.join(root, 'package-lock.json'))) return false;
  return [
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ].some((name) => exists(path.join(root, name)));
}

function pinManifestAndLock(binding: ProjectBinding): void {
  const manifest = readJsonIfExists<Record<string, unknown>>(binding.manifest) ?? {};
  const devDependencies = {
    ...((manifest['devDependencies'] as Record<string, unknown> | undefined) ?? {}),
    rijo: binding.version,
  };
  writeJsonAtomic(binding.manifest, { ...manifest, devDependencies });
  const lock = readJsonIfExists<{
    packages?: Record<string, Record<string, unknown>>;
  }>(binding.lockfile);
  if (!lock?.packages?.['']) {
    throw new Error('npm did not create a valid package-lock.json for the RIJO tooling environment.');
  }
  lock.packages['']['devDependencies'] = {
    ...((lock.packages['']['devDependencies'] as Record<string, unknown> | undefined) ?? {}),
    rijo: binding.version,
  };
  writeJsonAtomic(binding.lockfile, lock);
}

function renderProjectLauncher(input: {
  expectedVersion: string;
  toolingRootRelative: string;
}): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    `const expected = ${JSON.stringify(input.expectedVersion)};`,
    "const projectRoot = path.resolve(__dirname, '../..');",
    `const toolingRoot = path.resolve(__dirname, ${JSON.stringify(input.toolingRootRelative)});`,
    "const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));",
    "const fail = (message) => { console.error(`rijo: ${message}`); process.exit(1); };",
    "const manifestFile = path.join(toolingRoot, 'package.json');",
    "const lockFile = path.join(toolingRoot, 'package-lock.json');",
    "const packageFile = path.join(toolingRoot, 'node_modules', 'rijo', 'package.json');",
    "for (const file of [manifestFile, lockFile, packageFile]) {",
    "  if (!fs.existsSync(file)) fail(`missing project binding file: ${file}`);",
    "}",
    "const manifest = read(manifestFile);",
    "const lock = read(lockFile);",
    "const installed = read(packageFile);",
    "const declared = manifest.devDependencies && manifest.devDependencies.rijo;",
    "const locked = lock.packages && lock.packages[''] && lock.packages[''].devDependencies && lock.packages[''].devDependencies.rijo;",
    "const resolved = lock.packages && lock.packages['node_modules/rijo'] && lock.packages['node_modules/rijo'].version;",
    "if (declared !== expected || locked !== expected || resolved !== expected || installed.version !== expected) {",
    "  fail(`project binding mismatch. Expected ${expected}. Found manifest=${declared || 'missing'}, lock=${locked || 'missing'}, resolved=${resolved || 'missing'}, installed=${installed.version || 'missing'}. Run npx rijo install --project.`);",
    "}",
    "const entry = path.join(toolingRoot, 'node_modules', 'rijo', 'dist', 'cli', 'index.js');",
    "if (!fs.existsSync(entry)) fail(`missing local RIJO CLI: ${entry}`);",
    "const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { cwd: projectRoot, stdio: 'inherit' });",
    "if (result.error) fail(result.error.message);",
    "process.exit(result.status === null ? 1 : result.status);",
    '',
  ].join('\n');
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
