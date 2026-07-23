import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractZipSafely, UnsafeZipError } from '../src/security/zip.js';
import { tmpProject, cleanup } from './helpers.js';

describe('extractZipSafely', () => {
  let root: string;
  let dest: string;

  beforeEach(() => {
    root = tmpProject();
    dest = path.join(root, 'out');
  });

  afterEach(() => {
    cleanup(root);
  });

  function buildZip(name: string, add: (zip: AdmZip) => void): string {
    const zipPath = path.join(root, name);
    const zip = new AdmZip();
    add(zip);
    zip.writeZip(zipPath);
    return zipPath;
  }

  it('extracts a safe zip with nested files and inventories the entries', () => {
    const zipPath = buildZip('safe.zip', (zip) => {
      zip.addFile('a.txt', Buffer.from('hello'));
      zip.addFile('nested/dir/b.txt', Buffer.from('world!'));
    });

    const inspection = extractZipSafely(zipPath, dest);

    const names = inspection.entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.txt', 'nested/dir/b.txt']);
    expect(inspection.entries.find((e) => e.name === 'a.txt')!.size).toBe(5);
    expect(inspection.warnings).toEqual([]);
    expect(inspection.executables).toEqual([]);
    expect(inspection.installScripts).toEqual([]);

    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(dest, 'nested', 'dir', 'b.txt'), 'utf8')).toBe('world!');
  });

  it('throws UnsafeZipError on a path traversal entry', () => {
    const zipPath = buildZip('traversal.zip', (zip) => {
      // addFile sanitizes '../' in current adm-zip, so set the hostile
      // entry name afterwards; it survives writeZip verbatim.
      zip.addFile('placeholder.txt', Buffer.from('escaped'));
      zip.getEntries()[0]!.entryName = '../../evil.txt';
    });

    expect(() => extractZipSafely(zipPath, dest)).toThrow(UnsafeZipError);
    expect(() => extractZipSafely(zipPath, dest)).toThrow(/traversal/i);
    // nothing escaped the destination
    expect(fs.existsSync(path.join(root, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.resolve(dest, '..', '..', 'evil.txt'))).toBe(false);
  });

  it('throws UnsafeZipError on an absolute path entry', () => {
    const zipPath = buildZip('absolute.zip', (zip) => {
      zip.addFile('C:/evil.txt', Buffer.from('absolute'));
    });

    expect(() => extractZipSafely(zipPath, dest)).toThrow(UnsafeZipError);
    expect(() => extractZipSafely(zipPath, dest)).toThrow(/absolute path/i);
  });

  it('skips executables but extracts the rest, recording a warning', () => {
    const zipPath = buildZip('exe.zip', (zip) => {
      zip.addFile('tool.exe', Buffer.from('MZ...'));
      zip.addFile('readme.txt', Buffer.from('docs'));
    });

    const inspection = extractZipSafely(zipPath, dest);

    expect(fs.existsSync(path.join(dest, 'tool.exe'))).toBe(false);
    expect(fs.readFileSync(path.join(dest, 'readme.txt'), 'utf8')).toBe('docs');
    expect(inspection.executables).toEqual(['tool.exe']);
    expect(inspection.warnings).toContain('Executable not extracted: tool.exe');
    expect(inspection.entries.map((e) => e.name)).toEqual(['readme.txt']);
  });

  it('flags npm install scripts in package.json without executing them', () => {
    const pkg = {
      name: 'imported',
      version: '1.0.0',
      scripts: { build: 'tsc', postinstall: 'node evil.js' },
    };
    const zipPath = buildZip('scripts.zip', (zip) => {
      zip.addFile('package.json', Buffer.from(JSON.stringify(pkg)));
    });

    const inspection = extractZipSafely(zipPath, dest);

    expect(inspection.installScripts).toEqual(['package.json#postinstall']);
    expect(inspection.warnings).toContain(
      'Install script detected in package.json: postinstall (will not be executed)',
    );
    // the file itself is still extracted for inspection
    expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
  });
});
