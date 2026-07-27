import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInventory } from '../src/codebase/inventory.js';
import {
  assessMapCoverage,
  buildDependencyGraph,
  extractSurfaces,
  extractSymbols,
  validateFragmentDetailed,
  validateUniqueAnalysisOwnership,
} from '../src/codebase/analyze.js';
import { buildContextPacket, validatePlanMapReferences } from '../src/codebase/context.js';
import { PhasePlanDraftSchema } from '../src/core/schemas/index.js';
import { RijoPaths } from '../src/core/paths.js';
import { cleanup, tmpProject } from './helpers.js';

describe('map trust gates', () => {
  let root: string;
  let paths: RijoPaths;

  beforeEach(() => {
    root = tmpProject('rijo-map-trust-');
    paths = new RijoPaths(root);
    fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'payments'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'auth', 'session.ts'),
      'export class SessionService { static validate() { return true; } }\n',
    );
    fs.writeFileSync(path.join(root, 'src', 'auth', 'token.ts'), 'export const token = "safe";\n');
    fs.writeFileSync(path.join(root, 'src', 'payments', 'index.ts'), 'export const charge = () => true;\n');
    fs.writeFileSync(path.join(root, 'docs', 'architecture.md'), '# Architecture\n');
    fs.mkdirSync(paths.codebaseDir, { recursive: true });
    writeMapArtifacts();
  });

  afterEach(() => cleanup(root));

  function writeMapArtifacts(): void {
    const inventory = buildInventory(root);
    fs.writeFileSync(path.join(paths.codebaseDir, 'inventory.json'), JSON.stringify(inventory));
    fs.writeFileSync(path.join(paths.codebaseDir, 'symbols.json'), JSON.stringify(extractSymbols(root, inventory)));
    fs.writeFileSync(path.join(paths.codebaseDir, 'surfaces.json'), JSON.stringify(extractSurfaces(root, inventory)));
    fs.writeFileSync(path.join(paths.codebaseDir, 'dependency-graph.json'), JSON.stringify(buildDependencyGraph(inventory)));
    fs.writeFileSync(path.join(paths.codebaseDir, 'claims.json'), JSON.stringify({ schema_version: 1, claims: [] }));
    fs.writeFileSync(path.join(paths.codebaseDir, 'SUMMARY.md'), '# Summary\nAuthentication and payments.\n');
    fs.writeFileSync(path.join(paths.codebaseDir, 'ARCHITECTURE.md'), '# Architecture\nAuth owns session behavior.\n');
    fs.writeFileSync(path.join(paths.codebaseDir, 'CONVENTIONS.md'), '# Conventions\nKeep auth files in src/auth.\n');
    fs.writeFileSync(path.join(paths.codebaseDir, 'BASELINE.md'), '# Baseline\nPASSED\n');
    fs.writeFileSync(path.join(paths.codebaseDir, 'CONCERNS.md'), '# Concerns\nToken compatibility.\n');
    fs.writeFileSync(paths.decisions, '# Decisions\n\n## DEC-auth\nKeep the auth boundary.\n');
    fs.writeFileSync(
      paths.codebaseMapState,
      JSON.stringify({
        schema_version: 1,
        mapper_version: '1',
        status: 'COMPLETE',
        mapped_commit: 'commit-a',
        mapped_tree_hash: 'tree-a',
        mapped_at: '2026-07-26T00:00:00.000Z',
        branch: 'main',
        source_roots: ['src'],
        module_ids: ['src/auth', 'src/payments'],
        file_count: inventory.files.length,
        coverage: {},
        excluded_paths: [],
        artifact_hashes: {},
        baseline_status: 'PASSED',
        changed_paths_since_map: [],
        stale_reasons: [],
        gaps: [],
      }),
    );
  }

  function existing(pathname: string, symbol?: string) {
    const inventory = JSON.parse(fs.readFileSync(path.join(paths.codebaseDir, 'inventory.json'), 'utf8')) as {
      files: Array<{ path: string; file_hash: string }>;
    };
    const entry = inventory.files.find((file) => file.path === pathname)!;
    return { path: pathname, intent: 'existing' as const, file_hash: entry.file_hash, ...(symbol ? { symbol } : {}) };
  }

  function draft(first: Record<string, unknown>) {
    return PhasePlanDraftSchema.parse({
      phase: '01',
      tasks: [
        {
          id: 'T01',
          name: 'Trust gate',
          technical_justification: 'gate',
          files: ['src/auth/session.ts'],
          mapped_references: [existing('src/auth/session.ts')],
          write_scope: ['src/auth/session.ts'],
          tests: [],
          evidence_expected: 'gate enforced',
          ...first,
        },
        {
          id: 'T02',
          name: 'Second task',
          technical_justification: 'schema minimum',
          files: ['src/auth/token.ts'],
          mapped_references: [existing('src/auth/token.ts')],
          write_scope: ['src/auth/token.ts'],
          tests: [],
          evidence_expected: 'second gate',
        },
      ],
    });
  }

  it('rejects an existing task file with an empty mapped reference list', () => {
    const parsed = PhasePlanDraftSchema.safeParse({
      phase: '01',
      tasks: [
        {
          id: 'T01',
          name: 'Bypass',
          technical_justification: 'attempted bypass',
          files: ['src/auth/session.ts'],
          mapped_references: [],
          write_scope: ['src/auth/session.ts'],
          evidence_expected: 'must fail',
        },
        {
          id: 'T02',
          name: 'Second',
          technical_justification: 'minimum',
          files: ['src/auth/token.ts'],
          mapped_references: [existing('src/auth/token.ts')],
          write_scope: ['src/auth/token.ts'],
          evidence_expected: 'valid',
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects invented new paths without a parent module at schema time', () => {
    expect(() =>
      draft({
        files: ['src/auth/invented.ts'],
        mapped_references: [
          {
            path: 'src/auth/invented.ts',
            intent: 'new',
            placement_evidence: [{ path: 'src/auth', reason: 'owner' }],
          },
        ],
        write_scope: ['src/auth/invented.ts'],
      }),
    ).toThrow(/parent_module/i);
  });

  it('rejects a new file placed in an incompatible mapped module', () => {
    const plan = draft({
      files: ['src/payments/session-adapter.ts'],
      mapped_references: [
        {
          path: 'src/payments/session-adapter.ts',
          intent: 'new',
          parent_module: 'src/auth',
          placement_evidence: [{ path: 'src/auth', reason: 'auth owner' }],
        },
      ],
      write_scope: ['src/payments/session-adapter.ts'],
    });
    expect(validatePlanMapReferences(root, plan).map((issue) => issue.code)).toContain('MAP_PLACEMENT_INVALID');
  });

  it('rejects stale hashes, invented symbols, intent mismatches, and wider write scopes', () => {
    const stale = { ...existing('src/auth/session.ts', 'inventedSymbol'), file_hash: '0'.repeat(64) };
    const plan = draft({
      mapped_references: [stale],
      write_scope: ['src/auth/session.ts', 'src/auth/**'],
    });
    expect(validatePlanMapReferences(root, plan).map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['MAP_HASH_MISMATCH', 'MAP_SYMBOL_NOT_FOUND', 'MAP_WRITE_SCOPE_WIDER']),
    );
    const mismatch = draft({
      mapped_references: [
        {
          path: 'src/auth/session.ts',
          intent: 'new',
          parent_module: 'src/auth',
          placement_evidence: [{ path: 'src/auth', reason: 'owner' }],
        },
      ],
    });
    expect(validatePlanMapReferences(root, mismatch).map((issue) => issue.code)).toContain('MAP_INTENT_MISMATCH');
  });

  it('rejects behavioral shards with zero claims and gaps but accepts a documentation-only shard', () => {
    const inventory = buildInventory(root);
    const code = inventory.files.find((file) => file.path === 'src/auth/session.ts')!;
    const doc = inventory.files.find((file) => file.path === 'docs/architecture.md')!;
    const empty = (entry: typeof code) => ({
      shard_id: 'shard-1',
      module_ids: [entry.module_id],
      claims: [],
      gaps: [],
    });
    expect(validateFragmentDetailed(root, inventory, empty(code), new Set([code.path])).fragment).toBeNull();
    expect(validateFragmentDetailed(root, inventory, empty(doc), new Set([doc.path])).errors).toEqual([]);
  });

  it('enforces exact shard paths and explicitly marked neighbor contracts', () => {
    const inventory = buildInventory(root);
    const session = inventory.files.find((file) => file.path === 'src/auth/session.ts')!;
    const token = inventory.files.find((file) => file.path === 'src/auth/token.ts')!;
    const semanticCoverage = [
      'responsibility',
      'entrypoints',
      'contracts',
      'invariants',
      'dependencies',
      'consumers',
      'data_flow',
      'conventions',
      'tests',
      'operations',
      'risks',
      'placement',
    ].map((category) => ({
      module_id: session.module_id,
      category,
      status: ['responsibility', 'entrypoints', 'contracts', 'conventions', 'placement'].includes(category)
        ? 'COVERED'
        : 'NOT_APPLICABLE',
      rationale: `${category} disposition for the assigned session shard`,
    }));
    const fragment = (ownership: 'primary' | 'external_contract') => ({
      shard_id: 'session-shard',
      module_ids: [session.module_id],
      claims: [
        {
          kind: 'responsibility',
          statement: 'The assigned session shard owns session validation.',
          evidence: [{ path: session.path, file_hash: session.file_hash }],
        },
        {
          kind: 'contract',
          statement: 'The assigned session shard exports its validation contract.',
          evidence: [{ path: session.path, file_hash: session.file_hash }],
        },
        {
          kind: 'convention',
          statement: 'New session behavior belongs beside the session service.',
          evidence: [{ path: session.path, file_hash: session.file_hash }],
        },
        {
          kind: 'contract',
          statement: 'Session validation consumes the token contract.',
          evidence: [{ path: token.path, file_hash: token.file_hash, ownership }],
        },
      ],
      semantic_coverage: semanticCoverage,
      gaps: [],
    });
    expect(
      validateFragmentDetailed(root, inventory, fragment('primary'), new Set([session.path])).fragment,
    ).toBeNull();
    const allowed = validateFragmentDetailed(
      root,
      inventory,
      fragment('external_contract'),
      new Set([session.path]),
      new Set([token.path]),
    );
    expect(allowed.errors).toEqual([]);
    expect(allowed.receipt.accepted_evidence).toContainEqual({
      path: token.path,
      ownership: 'external_contract',
    });
  });

  it('rejects duplicate exact-path analysis owners', () => {
    expect(
      validateUniqueAnalysisOwnership([
        {
          shard_id: 'shard-a',
          accepted_evidence: [{ path: 'src/auth/session.ts', ownership: 'primary' }],
        },
        {
          shard_id: 'shard-b',
          accepted_evidence: [{ path: 'src/auth/session.ts', ownership: 'primary' }],
        },
      ]),
    ).toEqual([expect.stringMatching(/two analysis owners/)]);
  });

  it('derives claims_verified only from approved final receipts', () => {
    const inventory = buildInventory(root);
    const session = inventory.files.find((file) => file.path === 'src/auth/session.ts')!;
    const claims = [
      {
        claim_id: 'claim-approved',
        source_shard: 'a',
        kind: 'responsibility' as const,
        statement: 'Auth validates sessions.',
        evidence: [{ path: session.path, file_hash: session.file_hash, ownership: 'primary' as const }],
      },
      {
        claim_id: 'claim-rejected',
        source_shard: 'a',
        kind: 'risk' as const,
        statement: 'An unsupported risk claim.',
        evidence: [{ path: session.path, file_hash: session.file_hash, ownership: 'primary' as const }],
      },
    ];
    const receipt = (claim_id: string, final_disposition: 'APPROVED' | 'REJECTED' | 'SUPERSEDED') => ({
      claim_id,
      source_shard: 'a',
      structural_status: 'PASSED' as const,
      semantic_status:
        final_disposition === 'APPROVED'
          ? ('APPROVED' as const)
          : final_disposition === 'SUPERSEDED'
            ? ('SUPERSEDED' as const)
            : ('REJECTED' as const),
      reviewer_attempt: 'review-1',
      reviewed_at: '2026-07-26T00:00:00.000Z',
      evidence_hash: 'a'.repeat(64),
      final_disposition,
    });
    const assessment = assessMapCoverage(
      inventory,
      extractSymbols(root, inventory),
      extractSurfaces(root, inventory),
      buildDependencyGraph(inventory),
      claims,
      {
        baselineStatus: 'PASSED',
        gaps: [],
        runtimeAvailable: true,
        claimReceipts: [receipt('claim-approved', 'APPROVED'), receipt('claim-rejected', 'REJECTED')],
      },
    );
    expect(assessment.coverage.claims_verified).toBe(0.5);
    expect(assessment.status).toBe('BLOCKED');

    const superseded = assessMapCoverage(
      inventory,
      extractSymbols(root, inventory),
      extractSurfaces(root, inventory),
      buildDependencyGraph(inventory),
      claims,
      {
        baselineStatus: 'PASSED',
        gaps: [],
        runtimeAvailable: true,
        claimReceipts: [receipt('claim-approved', 'APPROVED'), receipt('claim-rejected', 'SUPERSEDED')],
      },
    );
    expect(superseded.coverage.claims_verified).toBe(0.5);
  });

  it('hashes relevant conventions, baseline, concerns, decisions, and gaps into the packet', () => {
    const first = buildContextPacket(root, 'auth session', 16_000, () => new Date('2026-07-26T00:00:00Z'));
    expect(first.text).toMatch(/Conventions|Baseline|Risks|Previous decisions|Freshness gaps/);
    fs.appendFileSync(path.join(paths.codebaseDir, 'CONVENTIONS.md'), '\n- New auth convention.\n');
    const second = buildContextPacket(root, 'auth session', 16_000, () => new Date('2026-07-26T00:00:00Z'));
    expect(second.packet_hash).not.toBe(first.packet_hash);
    expect(second.selected_paths).toContain('src/auth/session.ts');
    expect(second.mapped_commit).toBe('commit-a');
  });

  it.each([
    ['CONVENTIONS.md', 'New placement convention'],
    ['BASELINE.md', 'New baseline failure evidence'],
    ['CONCERNS.md', 'New auth risk'],
    ['DECISIONS.md', 'New auth decision'],
  ])('changes packet_hash when relevant %s changes', (artifact, content) => {
    const first = buildContextPacket(root, 'auth session', 16_000, () => new Date('2026-07-26T00:00:00Z'));
    const target = artifact === 'DECISIONS.md' ? paths.decisions : path.join(paths.codebaseDir, artifact);
    fs.appendFileSync(target, `\n${content}\n`);
    const second = buildContextPacket(root, 'auth session', 16_000, () => new Date('2026-07-26T00:00:00Z'));
    expect(second.packet_hash).not.toBe(first.packet_hash);
  });

  it('changes packet_hash when a relevant structured gap changes', () => {
    const first = buildContextPacket(root, 'auth session', 16_000, () => new Date('2026-07-26T00:00:00Z'));
    const state = JSON.parse(fs.readFileSync(paths.codebaseMapState, 'utf8'));
    state.gap_records = [
      {
        code: 'MAPPER_REPORTED',
        category: 'semantic',
        severity: 'non_critical',
        message: 'Auth session consumer is unknown.',
        affected_paths: ['src/auth/session.ts'],
        affected_modules: ['src/auth'],
      },
    ];
    fs.writeFileSync(paths.codebaseMapState, JSON.stringify(state));
    const second = buildContextPacket(root, 'auth session', 16_000, () => new Date('2026-07-26T00:00:00Z'));
    expect(second.packet_hash).not.toBe(first.packet_hash);
    expect(second.selected_gaps).toHaveLength(1);
  });
});
