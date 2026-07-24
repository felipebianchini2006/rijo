import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXPERT_PROFILES, EXPERT_PROFILE_MAP, EXPERT_PROFILE_IDS } from '../src/experts/catalog.js';
import {
  routeProfiles,
  validateProfiles,
  InvalidExpertProfileError,
  TooManyExpertProfilesError,
  type RouteInput,
} from '../src/experts/router.js';
import { renderProfileBrief, buildConsultAdvisoryTask } from '../src/experts/embed.js';
import { renderBrief } from '../src/agents/prompts.js';
import { AgentTaskSchema, type AgentTask } from '../src/agents/protocol.js';
import { generateAdapters } from '../src/adapters/index.js';
import { cleanup, tmpProject } from './helpers.js';

function task(partial: Partial<AgentTask> & { id: string }): AgentTask {
  return AgentTaskSchema.parse({
    role: 'worker',
    objective: `objective for ${partial.id}`,
    return_format: 'one-line summary',
    ...partial,
  });
}

describe('expert profile catalog', () => {
  it('has exactly the 10 canonical profiles', () => {
    expect(EXPERT_PROFILE_IDS).toEqual([
      'discovery-analyst',
      'product-manager',
      'system-architect',
      'ux-product-designer',
      'senior-software-engineer',
      'technical-writer',
      'test-architect',
      'security-engineer',
      'devops-sre',
      'debugger',
    ]);
  });

  it('only senior-software-engineer and debugger declare task-scope write policy', () => {
    for (const p of EXPERT_PROFILES) {
      const expected = p.id === 'senior-software-engineer' || p.id === 'debugger' ? 'task-scope' : 'none';
      expect(p.default_write_policy, p.id).toBe(expected);
    }
  });

  it('every token_budget is within [300, 600]', () => {
    for (const p of EXPERT_PROFILES) {
      expect(p.token_budget, p.id).toBeGreaterThanOrEqual(300);
      expect(p.token_budget, p.id).toBeLessThanOrEqual(600);
    }
  });
});

describe('routeProfiles (deterministic router)', () => {
  const cases: RouteInput[] = [
    { role: 'worker', stage: 'EXECUTE' },
    { role: 'reviewer', stage: 'CODE_REVIEW' },
    { role: 'reviewer', stage: 'CODE_REVIEW', requirement_tags: ['security'] },
    { role: 'researcher', stage: 'RESEARCH' },
    { role: 'researcher' },
    { role: 'qa', stage: 'UI_SMOKE' },
    { role: 'planner', stage: 'PLAN' },
    { role: 'worker', stage: 'EXECUTE', paths: ['Dockerfile'] },
    { role: 'worker', paths: ['docs/readme.md'] },
    { role: 'worker', stage: 'DIAGNOSE' },
    { role: 'lead', high_risk: true },
  ];

  it('is deterministic: the same input always yields the same output', () => {
    for (const input of cases) {
      const a = routeProfiles(input);
      const b = routeProfiles({ ...input });
      expect(b).toEqual(a);
    }
  });

  it('never returns more than 3 total profiles', () => {
    for (const input of cases) {
      const r = routeProfiles(input);
      expect(1 + r.complementary.length).toBeLessThanOrEqual(3);
    }
  });

  it('never exceeds the 1500 combined token budget', () => {
    for (const input of cases) {
      const r = routeProfiles(input);
      const total = [r.primary, ...r.complementary].reduce(
        (sum, id) => sum + (EXPERT_PROFILE_MAP.get(id)?.token_budget ?? 0),
        0,
      );
      expect(total).toBeLessThanOrEqual(1500);
    }
  });

  it('worker/lead roles always resolve a non-empty primary', () => {
    expect(routeProfiles({ role: 'worker' }).primary).toBeTruthy();
    expect(routeProfiles({ role: 'lead' }).primary).toBeTruthy();
  });

  it('researcher (read-only) always receives exactly 1 profile', () => {
    expect(routeProfiles({ role: 'researcher' }).complementary).toEqual([]);
    expect(routeProfiles({ role: 'researcher', stage: 'RESEARCH' }).complementary).toEqual([]);
    expect(routeProfiles({ role: 'researcher', paths: ['docs/x.md'] }).complementary).toEqual([]);
    expect(routeProfiles({ role: 'researcher', requirement_tags: ['security'] }).complementary).toEqual([]);
  });

  it('CODE_REVIEW never inherits the authoral senior-software-engineer profile', () => {
    expect(routeProfiles({ role: 'reviewer', stage: 'CODE_REVIEW' }).primary).not.toBe('senior-software-engineer');
    expect(
      routeProfiles({ role: 'reviewer', stage: 'CODE_REVIEW', requirement_tags: ['security'] }).primary,
    ).not.toBe('senior-software-engineer');
  });

  it('CODE_REVIEW defaults to test-architect and swaps to security-engineer on a security tag', () => {
    expect(routeProfiles({ role: 'reviewer', stage: 'CODE_REVIEW' }).primary).toBe('test-architect');
    expect(
      routeProfiles({ role: 'reviewer', stage: 'CODE_REVIEW', requirement_tags: ['security'] }).primary,
    ).toBe('security-engineer');
  });

  it('EXECUTE maps to senior-software-engineer', () => {
    expect(routeProfiles({ role: 'worker', stage: 'EXECUTE' }).primary).toBe('senior-software-engineer');
  });

  it('SPEC_READY/PLAN map to product-manager with system-architect as complementary', () => {
    const r = routeProfiles({ role: 'planner', stage: 'PLAN' });
    expect(r.primary).toBe('product-manager');
    expect(r.complementary).toContain('system-architect');
  });

  it('UI_SMOKE/JOURNEYS map to ux-product-designer with test-architect as complementary', () => {
    const r = routeProfiles({ role: 'qa', stage: 'UI_SMOKE' });
    expect(r.primary).toBe('ux-product-designer');
    expect(r.complementary).toContain('test-architect');
  });

  it('RESEARCH maps to discovery-analyst', () => {
    expect(routeProfiles({ role: 'researcher', stage: 'RESEARCH' }).primary).toBe('discovery-analyst');
  });

  it('DIAGNOSE/REPRODUCE/REPAIR map to debugger', () => {
    expect(routeProfiles({ role: 'worker', stage: 'DIAGNOSE' }).primary).toBe('debugger');
    expect(routeProfiles({ role: 'worker', stage: 'REPRODUCE' }).primary).toBe('debugger');
    expect(routeProfiles({ role: 'worker', stage: 'REPAIR' }).primary).toBe('debugger');
  });

  it('pure-docs paths route to technical-writer', () => {
    const r = routeProfiles({ role: 'worker', stage: 'EXECUTE', paths: ['docs/expert-profiles.md'] });
    expect(r.primary).toBe('technical-writer');
  });

  it('pure-infra paths route to devops-sre', () => {
    const r = routeProfiles({ role: 'worker', stage: 'EXECUTE', paths: ['Dockerfile'] });
    expect(r.primary).toBe('devops-sre');
  });

  it('mixed paths do not override the stage-based primary', () => {
    const r = routeProfiles({ role: 'worker', stage: 'EXECUTE', paths: ['src/a.ts', 'docs/x.md'] });
    expect(r.primary).toBe('senior-software-engineer');
  });

  it('a security tag guarantees a security-engineer lens outside CODE_REVIEW too', () => {
    const r = routeProfiles({ role: 'worker', stage: 'EXECUTE', requirement_tags: ['security'] });
    expect([r.primary, ...r.complementary]).toContain('security-engineer');
  });

  it('high_risk selects consult mode; otherwise embed', () => {
    expect(routeProfiles({ role: 'worker', stage: 'EXECUTE' }).mode).toBe('embed');
    expect(routeProfiles({ role: 'worker', stage: 'EXECUTE', high_risk: true }).mode).toBe('consult');
  });
});

describe('validateProfiles', () => {
  it('throws InvalidExpertProfileError for an unknown id, listing valid ids', () => {
    expect(() => validateProfiles(['not-a-real-profile'])).toThrow(InvalidExpertProfileError);
    try {
      validateProfiles(['not-a-real-profile']);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('not-a-real-profile');
      expect((e as Error).message).toContain('discovery-analyst');
    }
  });

  it('throws TooManyExpertProfilesError for more than 3 valid ids', () => {
    expect(() =>
      validateProfiles(['discovery-analyst', 'product-manager', 'system-architect', 'ux-product-designer']),
    ).toThrow(TooManyExpertProfilesError);
  });

  it('does not throw for up to 3 valid ids', () => {
    expect(() => validateProfiles(['discovery-analyst', 'product-manager', 'system-architect'])).not.toThrow();
  });
});

describe('renderProfileBrief / buildConsultAdvisoryTask', () => {
  it('renders mission, checklist, anti-patterns and output contract for each selected profile', () => {
    const text = renderProfileBrief(['debugger']);
    const p = EXPERT_PROFILE_MAP.get('debugger')!;
    expect(text).toContain(p.mission);
    for (const c of p.checklist) expect(text).toContain(c);
    for (const a of p.anti_patterns) expect(text).toContain(a);
    expect(text).toContain(p.output_contract);
  });

  it('throws before rendering when given an invalid profile id', () => {
    expect(() => renderProfileBrief(['nope'])).toThrow(InvalidExpertProfileError);
  });

  it('buildConsultAdvisoryTask produces a read-only reviewer draft with a short JSON advisory contract', () => {
    const draft = buildConsultAdvisoryTask('security-engineer', 'evaluate the new auth middleware');
    expect(draft.role).toBe('reviewer');
    expect(draft.write_scope).toEqual([]);
    expect(draft.workspace).toBeNull();
    expect(draft.expert_profiles).toEqual(['security-engineer']);
    expect(String(draft.return_format)).toContain('concerns');
    expect(String(draft.return_format)).toContain('severity');
  });
});

describe('renderBrief expert-guidance injection', () => {
  it('injects only the selected profiles and nothing else', () => {
    const brief = renderBrief(
      task({ id: 'T-expert', expert_profiles: ['test-architect'], return_format: 'x' }),
    );
    expect(brief).toContain('## Expert guidance');
    expect(brief).toContain(EXPERT_PROFILE_MAP.get('test-architect')!.mission);
    // a profile that was NOT selected must not leak into the brief
    expect(brief).not.toContain(EXPERT_PROFILE_MAP.get('debugger')!.mission);
  });

  it('omits the Expert guidance section entirely when no profiles are selected', () => {
    const brief = renderBrief(task({ id: 'T-no-expert' }));
    expect(brief).not.toContain('## Expert guidance');
  });

  it('throws before producing any brief when an invalid profile id is set', () => {
    const t = AgentTaskSchema.parse({
      id: 'T-bad-expert',
      role: 'worker',
      objective: 'x',
      return_format: 'x',
      expert_profiles: ['totally-invalid'],
    });
    expect(() => renderBrief(t)).toThrow(InvalidExpertProfileError);
  });

  it('keeps the rest of the brief intact (objective, write scope, acceptance, verification, return format)', () => {
    const brief = renderBrief(
      task({
        id: 'T-full',
        objective: 'Implement the catalog module',
        write_scope: ['src/catalog.ts'],
        acceptance_criteria: ['listing works'],
        verification_commands: ['npm test'],
      }),
    );
    expect(brief).toContain('## Objective');
    expect(brief).toContain('Implement the catalog module');
    expect(brief).toContain('## Write scope (you may ONLY write these)');
    expect(brief).toContain('## Acceptance criteria');
    expect(brief).toContain('## Verification commands');
    expect(brief).toContain('## Return format');
  });
});

describe('adapters generated from a single expert catalog source', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject('rijo-experts-adapters-');
  });

  afterEach(() => {
    cleanup(root);
  });

  it('generates one .claude/agents/rijo-expert-<id>.md per catalog profile with a valid concrete Claude model', () => {
    generateAdapters(root, ['claude']);
    for (const p of EXPERT_PROFILES) {
      const file = path.join(root, '.claude', 'agents', `rijo-expert-${p.id}.md`);
      expect(fs.existsSync(file), file).toBe(true);
      const content = fs.readFileSync(file, 'utf8');
      const modelLine = content.match(/^model:\s*(.+)$/m)?.[1]?.trim();
      expect(modelLine, content).toBeDefined();
      expect(['opus', 'sonnet', 'haiku', 'fable']).toContain(modelLine!);
      expect(content).toContain(p.mission);
      const permissionMode = content.match(/^permissionMode:\s*(.+)$/m)?.[1]?.trim();
      expect(['default', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan']).toContain(permissionMode!);
      if (p.default_write_policy === 'task-scope') {
        expect(permissionMode).toBe('acceptEdits');
      } else {
        expect(permissionMode).toBe('plan');
        expect(content).toMatch(/^disallowedTools:.*Write.*Edit.*Bash/m);
      }
    }
  });

  it('generates one .agents/experts/<id>.toml per catalog profile with a valid concrete Codex model', () => {
    generateAdapters(root, ['codex']);
    for (const p of EXPERT_PROFILES) {
      const file = path.join(root, '.agents', 'experts', `${p.id}.toml`);
      expect(fs.existsSync(file), file).toBe(true);
      const content = fs.readFileSync(file, 'utf8');
      const modelLine = content.match(/^model\s*=\s*"(.+)"$/m)?.[1];
      expect(modelLine, content).toBeDefined();
      expect(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']).toContain(modelLine!);
      expect(content).toContain(p.mission);
      const sandbox = content.match(/^sandbox\s*=\s*"(.+)"$/m)?.[1];
      expect(sandbox).toBe(p.default_write_policy === 'task-scope' ? 'workspace-write' : 'read-only');
    }
  });

  it('the claude and codex adapters embed the IDENTICAL mission text for every profile (single source)', () => {
    generateAdapters(root, ['claude']);
    generateAdapters(root, ['codex']);
    for (const p of EXPERT_PROFILES) {
      const claudeContent = fs.readFileSync(path.join(root, '.claude', 'agents', `rijo-expert-${p.id}.md`), 'utf8');
      const codexContent = fs.readFileSync(path.join(root, '.agents', 'experts', `${p.id}.toml`), 'utf8');
      expect(claudeContent).toContain(p.mission);
      expect(codexContent).toContain(p.mission);
      for (const c of p.checklist) {
        expect(claudeContent).toContain(c);
        expect(codexContent).toContain(c);
      }
    }
  });
});
