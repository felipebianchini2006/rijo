import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generatePlaywrightSpecs } from '../src/qa/playwright.js';
import { deriveJourneys } from '../src/qa/journeys.js';
import { RequirementSchema } from '../src/core/schemas/index.js';
import { newWorkflow } from '../src/workflows/new.js';
import { checkWorkflow } from '../src/workflows/check.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { tmpProject, cleanup, writePlanFile, deps } from './helpers.js';

describe('playwright spec generation', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
  });
  afterEach(() => cleanup(root));

  it('generates one traceable spec per journey with console/network gates', () => {
    const reqs = [
      RequirementSchema.parse({ id: 'M001-REQ-001', description: 'Catálogo', acceptance: 'lista visível', phase: '01' }),
      RequirementSchema.parse({ id: 'M001-REQ-002', description: 'Checkout', acceptance: 'compra concluída', phase: '02' }),
    ];
    const journeys = deriveJourneys(reqs);
    const files = generatePlaywrightSpecs(journeys, root);
    expect(files).toHaveLength(2);
    const spec = fs.readFileSync(files[0]!, 'utf8');
    expect(spec).toContain("from '@playwright/test'");
    expect(spec).toContain('M001-REQ-001');
    expect(spec).toContain('consoleErrors');
    expect(spec).toContain('networkErrors');
    expect(spec).toContain('CRITICAL journey');
  });

  it('rijo check writes the specs into qa/journeys/', async () => {
    writePlanFile(root);
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLANO.md' }, d);
    await checkWorkflow(root, {}, d); // BLOCKED (no browser) but specs are still generated
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const m = manifest.milestones[0]!;
    const journeysDir = path.join(paths.milestoneDir(m.id, m.slug), 'qa', 'journeys');
    const specs = fs.readdirSync(journeysDir).filter((f) => f.endsWith('.spec.ts'));
    expect(specs).toEqual(['j01.spec.ts', 'j02.spec.ts']);
  });
});
