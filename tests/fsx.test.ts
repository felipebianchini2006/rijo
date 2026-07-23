import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeFileAtomic,
  writeJsonAtomic,
  sha256,
  inventory,
  totalSize,
  assertInsideRoot,
} from '../src/core/fsx.js';
import { tmpProject, cleanup } from './helpers.js';

describe('fsx', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject();
  });

  afterEach(() => {
    cleanup(root);
  });

  describe('writeFileAtomic', () => {
    it('writes the full content and leaves no temp files behind', () => {
      const target = path.join(root, 'sub', 'file.txt');
      const content = 'line\n'.repeat(5000);
      writeFileAtomic(target, content);
      expect(fs.readFileSync(target, 'utf8')).toBe(content);
      const leftovers = fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });

    it('overwrites an existing file completely', () => {
      const target = path.join(root, 'file.txt');
      writeFileAtomic(target, 'old content that is fairly long');
      writeFileAtomic(target, 'new');
      expect(fs.readFileSync(target, 'utf8')).toBe('new');
      const leftovers = fs.readdirSync(root).filter((n) => n.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });
  });

  describe('writeJsonAtomic', () => {
    it('writes pretty-printed JSON with a trailing newline', () => {
      const target = path.join(root, 'data.json');
      writeJsonAtomic(target, { a: 1, b: ['x'] });
      const raw = fs.readFileSync(target, 'utf8');
      expect(raw).toBe(JSON.stringify({ a: 1, b: ['x'] }, null, 2) + '\n');
      expect(JSON.parse(raw)).toEqual({ a: 1, b: ['x'] });
    });
  });

  describe('sha256', () => {
    it('hashes strings to the known digest', () => {
      expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      expect(sha256('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });

    it('hashes buffers the same as equivalent strings', () => {
      expect(sha256(Buffer.from('hello'))).toBe(sha256('hello'));
    });
  });

  describe('inventory', () => {
    it('lists files recursively but skips node_modules and .git', () => {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.writeFileSync(path.join(root, 'a.txt'), 'aa', 'utf8');
      fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'bbb', 'utf8');
      fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
      fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref', 'utf8');

      const entries = inventory(root);
      const names = entries.map((e) => e.relPath).sort();
      expect(names).toEqual(['a.txt', 'src/b.ts']);
      expect(entries.find((e) => e.relPath === 'a.txt')!.size).toBe(2);
      expect(entries.find((e) => e.relPath === 'src/b.ts')!.size).toBe(3);
    });
  });

  describe('totalSize', () => {
    it('sums existing files and ignores missing ones', () => {
      const a = path.join(root, 'a.txt');
      const b = path.join(root, 'b.txt');
      fs.writeFileSync(a, 'x'.repeat(10), 'utf8');
      fs.writeFileSync(b, 'y'.repeat(7), 'utf8');
      expect(totalSize([a, b, path.join(root, 'missing.txt')])).toBe(17);
      expect(totalSize([])).toBe(0);
    });
  });

  describe('assertInsideRoot', () => {
    it('accepts relative paths inside the root', () => {
      const resolved = assertInsideRoot(root, path.join('sub', 'file.txt'));
      expect(resolved).toBe(path.resolve(root, 'sub', 'file.txt'));
    });

    it('rejects ../escape', () => {
      expect(() => assertInsideRoot(root, '../escape')).toThrow(/escapes workspace root/);
    });

    it('rejects absolute paths outside the root', () => {
      const other = tmpProject('rijo-outside-');
      try {
        expect(() => assertInsideRoot(root, path.join(other, 'evil.txt'))).toThrow(
          /escapes workspace root/,
        );
      } finally {
        cleanup(other);
      }
    });
  });
});
