import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generatePlaywrightSpecs, lintPlaywrightSpec } from '../src/qa/playwright.js';
import { deriveJourneys, type JourneyAction } from '../src/qa/journeys.js';
import { RequirementSchema } from '../src/core/schemas/index.js';
import { newWorkflow } from '../src/workflows/new.js';
import { checkWorkflow } from '../src/workflows/check.js';
import { RijoPaths } from '../src/core/paths.js';
import { readManifest } from '../src/core/manifest.js';
import { tmpProject, cleanup, writePlanFile, deps } from './helpers.js';

const ACTIONS: JourneyAction[] = [
  { action: 'goto', path: '/' },
  { action: 'fill', selector: '#name', value: 'Maria' },
  { action: 'click', selector: '#submit' },
  { action: 'expect_text', selector: '#result', text: 'Hello, Maria', requirement_id: 'M001-REQ-001' },
];

describe('playwright spec generation (structured actions only)', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProject();
  });
  afterEach(() => cleanup(root));

  it('generates a real, traceable spec from structured actions; no actions → no spec', () => {
    const reqs = [
      RequirementSchema.parse({ id: 'M001-REQ-001', description: 'Catalog', acceptance: 'list is visible', phase: '01' }),
      RequirementSchema.parse({ id: 'M001-REQ-002', description: 'Checkout', acceptance: 'purchase is complete', phase: '02' }),
    ];
    const journeys = deriveJourneys(reqs);
    // only the first journey has actions — the second must NOT get a placeholder
    const specs = generatePlaywrightSpecs(journeys, root, 'http://127.0.0.1:3000', {}, { [journeys[0]!.id]: ACTIONS });
    expect(specs).toHaveLength(1);
    const spec = fs.readFileSync(specs[0]!.file, 'utf8');
    expect(spec).toContain("from '@playwright/test'");
    expect(spec).toContain('M001-REQ-001');
    expect(spec).toContain('consoleErrors');
    expect(spec).toContain('networkErrors');
    expect(spec).toContain('CRITICAL journey');
    // real UI actions, not body-visible placeholders
    expect(spec).toContain('page.locator("#name").fill("Maria")');
    expect(spec).toContain('page.locator("#submit").click()');
    expect(spec).toContain('toContainText("Hello, Maria")');
    // the generated spec passes its own anti-placeholder lint
    expect(lintPlaywrightSpec(spec, journeys[0]!)).toEqual([]);
  });

  it('lint rejects placeholder-only or unlinked specs', () => {
    const journey = { id: 'J01', name: 'x', requirement_ids: ['M001-REQ-001'], persona: 'p', critical: true };
    const placeholder = `import { test, expect } from '@playwright/test';\n// TODO fill in\ntest('x', async ({ page }) => {\n  await expect(page.locator('body')).toBeVisible();\n});`;
    const issues = lintPlaywrightSpec(placeholder, journey);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('SPEC_PLACEHOLDER');
    expect(codes).toContain('SPEC_NO_REAL_ACTION');
    expect(codes).toContain('SPEC_NO_REQUIREMENT_LINK');
  });

  it('rijo check writes specs into qa/journeys/ only for journeys with actions', async () => {
    writePlanFile(root);
    const d = deps(root);
    await newWorkflow(root, { planFile: '@PLAN.md' }, d);
    const paths = new RijoPaths(root);
    const manifest = readManifest(paths)!;
    const m = manifest.milestones[0]!;
    const journeysDir = path.join(paths.milestoneDir(m.id, m.slug), 'qa', 'journeys');
    fs.mkdirSync(journeysDir, { recursive: true });
    fs.writeFileSync(
      path.join(journeysDir, 'j01.actions.json'),
      JSON.stringify({ journey_id: 'J01', actions: ACTIONS }),
    );
    await checkWorkflow(root, {}, d); // BLOCKED (no browser runtime) but specs are still generated
    const specs = fs.readdirSync(journeysDir).filter((f) => f.endsWith('.spec.ts'));
    expect(specs).toEqual(['j01.spec.ts']); // J02 has no actions → no placeholder spec
  });
});
