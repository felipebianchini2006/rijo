import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkContextBudget } from '../src/core/contextBudget.js';
import { tmpProject, cleanup } from './helpers.js';

describe('checkContextBudget', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject();
  });

  afterEach(() => {
    cleanup(root);
  });

  function file(name: string, bytes: number): string {
    const p = path.join(root, name);
    fs.writeFileSync(p, 'a'.repeat(bytes), 'utf8');
    return p;
  }

  it('reports within budget when total size fits', () => {
    const a = file('a.md', 100);
    const b = file('b.md', 200);
    const report = checkContextBudget([a, b], 1000);
    expect(report.bytes).toBe(300);
    expect(report.budget).toBe(1000);
    expect(report.withinBudget).toBe(true);
    expect(report.files).toEqual([a, b]);
  });

  it('reports over budget when total size exceeds the budget', () => {
    const a = file('a.md', 600);
    const b = file('b.md', 500);
    const report = checkContextBudget([a, b], 1000);
    expect(report.bytes).toBe(1100);
    expect(report.withinBudget).toBe(false);
  });

  it('treats exactly-at-budget as within budget', () => {
    const a = file('a.md', 1000);
    expect(checkContextBudget([a], 1000).withinBudget).toBe(true);
  });

  it('ignores missing files', () => {
    const a = file('a.md', 50);
    const report = checkContextBudget([a, path.join(root, 'missing.md')], 100);
    expect(report.bytes).toBe(50);
    expect(report.withinBudget).toBe(true);
  });
});
