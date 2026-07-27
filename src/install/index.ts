import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { detectClaude, generateClaudeAdapter } from '../adapters/claude.js';
import { detectCodex, generateCodexAdapter } from '../adapters/codex.js';
import type { AdapterReport } from '../adapters/shared.js';
import { exists } from '../core/fsx.js';

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

export interface InstallReport extends AdapterReport {
  root: string;
  scope: InstallScope;
  hosts: InstallHost[];
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
  };

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
