import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeRequirements,
  writeRoadmap,
  type RequirementsDoc,
  type RoadmapDoc,
} from '../src/core/roadmap.js';
import { tmpProject, cleanup } from './helpers.js';

/**
 * Golden-file tests: the full canonical artifact content is embedded here.
 * Any change to front matter serialization or body rendering must be
 * deliberate and update these goldens.
 */

const REQUIREMENTS_DOC: RequirementsDoc = {
  milestone: 'M001',
  requirements: [
    {
      id: 'M001-REQ-001',
      description: 'Product catalog with listing',
      acceptance: 'User sees the product list',
      phase: '01',
      status: 'PENDING',
      classification: 'NEW',
      carried_from: null,
      tests: [],
      evidence: null,
      no_test_justification: null,
    },
  ],
};

const GOLDEN_REQUIREMENTS = [
  '---',
  'milestone: M001',
  'requirements:',
  '  - id: M001-REQ-001',
  '    description: Product catalog with listing',
  '    acceptance: User sees the product list',
  '    phase: "01"',
  '    status: PENDING',
  '    classification: NEW',
  '    carried_from: null',
  '    tests: []',
  '    evidence: null',
  '    no_test_justification: null',
  '---',
  '',
  '# Requirements — M001',
  '',
  '| ID | Status | Class | Phase | Description |',
  '|---|---|---|---|---|',
  '| M001-REQ-001 | PENDING | NEW | 01 | Product catalog with listing |',
  '',
].join('\n');

const ROADMAP_DOC: RoadmapDoc = {
  milestone: 'M001',
  phases: [
    {
      id: '01',
      slug: 'catalog',
      name: 'Catalog',
      depends_on: [],
      requirements: ['M001-REQ-001'],
      status: 'PENDING',
      ui_surface: true,
      commit: null,
    },
  ],
};

const GOLDEN_ROADMAP = [
  '---',
  'milestone: M001',
  'phases:',
  '  - id: "01"',
  '    slug: catalog',
  '    name: Catalog',
  '    depends_on: []',
  '    requirements:',
  '      - M001-REQ-001',
  '    status: PENDING',
  '    ui_surface: true',
  '    commit: null',
  '---',
  '',
  '# Roadmap — M001',
  '',
  '## 01 — Catalog [PENDING]',
  'Requirements: M001-REQ-001',
].join('\n');

describe('golden files', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('writeRequirements produces the exact golden REQUIREMENTS.md', () => {
    const p = path.join(root, 'REQUIREMENTS.md');
    writeRequirements(p, REQUIREMENTS_DOC);
    expect(fs.readFileSync(p, 'utf8')).toBe(GOLDEN_REQUIREMENTS);
  });

  it('writeRoadmap produces the exact golden ROADMAP.md', () => {
    const p = path.join(root, 'ROADMAP.md');
    writeRoadmap(p, ROADMAP_DOC);
    expect(fs.readFileSync(p, 'utf8')).toBe(GOLDEN_ROADMAP);
  });
});
