import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir } from '../core/fsx.js';

export interface ZipInspection {
  entries: Array<{ name: string; size: number }>;
  warnings: string[];
  executables: string[];
  installScripts: string[];
}

export class UnsafeZipError extends Error {
  constructor(
    message: string,
    public readonly entry?: string,
  ) {
    super(message);
    this.name = 'UnsafeZipError';
  }
}

const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const EXECUTABLE_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.ps1', '.sh', '.msi', '.com', '.scr']);
const INSTALL_SCRIPTS = new Set(['postinstall', 'preinstall', 'install']);

/**
 * Guarded ZIP extraction for design imports. Rejects path traversal, absolute
 * paths, symlinks and oversized archives; flags executables and npm install
 * scripts. Nothing from the archive is ever executed here.
 */
export function extractZipSafely(zipPath: string, destDir: string): ZipInspection {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) {
    throw new UnsafeZipError(`Archive has ${entries.length} entries (limit ${MAX_ENTRIES})`);
  }

  const inspection: ZipInspection = { entries: [], warnings: [], executables: [], installScripts: [] };
  const seen = new Set<string>();
  let total = 0;
  const resolvedDest = path.resolve(destDir);
  ensureDir(resolvedDest);

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
      throw new UnsafeZipError(`Absolute path in archive: ${name}`, name);
    }
    const target = path.resolve(resolvedDest, name);
    if (!target.startsWith(resolvedDest + path.sep) && target !== resolvedDest) {
      throw new UnsafeZipError(`Path traversal attempt: ${name}`, name);
    }
    // symlink detection: unix external attributes encode file mode in high 16 bits
    const mode = entry.header.attr >>> 16;
    if ((mode & 0o170000) === 0o120000) {
      throw new UnsafeZipError(`Symlink in archive: ${name}`, name);
    }
    if (entry.isDirectory) continue;

    const size = entry.header.size;
    if (size > MAX_ENTRY_BYTES) {
      throw new UnsafeZipError(`Entry too large (${size} bytes): ${name}`, name);
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      throw new UnsafeZipError(`Archive exceeds total size limit (${MAX_TOTAL_BYTES} bytes)`);
    }

    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      inspection.warnings.push(`Name collision (case-insensitive): ${name}`);
      continue;
    }
    seen.add(lower);

    const ext = path.extname(lower);
    if (EXECUTABLE_EXT.has(ext)) {
      inspection.executables.push(name);
      inspection.warnings.push(`Executable not extracted: ${name}`);
      continue;
    }
    if (path.basename(lower) === 'package.json') {
      try {
        const pkg = JSON.parse(entry.getData().toString('utf8')) as { scripts?: Record<string, string> };
        for (const s of Object.keys(pkg.scripts ?? {})) {
          if (INSTALL_SCRIPTS.has(s)) {
            inspection.installScripts.push(`${name}#${s}`);
            inspection.warnings.push(`Install script detected in ${name}: ${s} (will not be executed)`);
          }
        }
      } catch {
        inspection.warnings.push(`Unparseable package.json: ${name}`);
      }
    }

    ensureDir(path.dirname(target));
    fs.writeFileSync(target, entry.getData());
    inspection.entries.push({ name, size });
  }
  return inspection;
}
