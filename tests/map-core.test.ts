import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildInventory, MapPreflightError } from '../src/codebase/inventory.js';
import { buildContextPacket, validatePlanMapReferences } from '../src/codebase/context.js';
import { extractSymbols, validateFragmentDetailed } from '../src/codebase/analyze.js';
import { PhasePlanSchema } from '../src/core/schemas/index.js';
import { EvidenceSchema, MapClaimSchema } from '../src/codebase/schemas.js';
import { cleanup, tmpProject } from './helpers.js';

describe('codebase inventory', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject('rijo-map-core-');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'vendor-lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }));
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const publicApi = () => true;\n');
    fs.writeFileSync(path.join(root, 'tests', 'index.test.ts'), 'it("works", () => {});\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'vendor-lib', 'index.js'), 'secret vendor code');
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'generated code');
    fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=sk-this-value-must-never-be-read-or-written\n');
  });

  afterEach(() => cleanup(root));

  it('classifies every relevant file, excludes generated/vendor/sensitive paths, and never persists credential values', () => {
    const result = buildInventory(root);
    expect(result.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['package.json', 'src/index.ts', 'tests/index.test.ts']),
    );
    expect(result.files.find((f) => f.path === 'src/index.ts')).toMatchObject({
      kind: 'code',
      module_id: expect.any(String),
      file_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.excluded_paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '.env', reason: 'sensitive' }),
        expect.objectContaining({ path: 'dist', reason: 'generated' }),
        expect.objectContaining({ path: 'node_modules', reason: 'vendor' }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('sk-this-value');
    expect(result.coverage.relevant_files_classified).toBe(1);
  });

  it('fails closed when a symlink escapes the repository', () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(root, 'src', 'outside-link'));
    try {
      expect(() => buildInventory(root)).toThrow(MapPreflightError);
      expect(() => buildInventory(root)).toThrow(/symlink/i);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('normalizes host line tuples into the canonical evidence range', () => {
    expect(
      EvidenceSchema.parse({ path: 'src/index.ts', lines: [4, 9], file_hash: 'a'.repeat(64) }).lines,
    ).toBe('4-9');
    expect(
      EvidenceSchema.parse({ path: 'src/index.ts', lines: { start: '4', end: '9' }, file_hash: 'a'.repeat(64) }).lines,
    ).toBe('4-9');
    expect(
      MapClaimSchema.parse({
        kind: 'testing',
        statement: 'Tests exist.',
        evidence: [{ path: 'test/index.test.ts', file_hash: 'b'.repeat(64) }],
      }).kind,
    ).toBe('operation');
  });

  it('splits comma-joined host symbols but still validates every symbol against the live file', () => {
    fs.writeFileSync(
      path.join(root, 'src', 'index.ts'),
      'export const publicApi = () => true;\nexport const secondaryApi = () => false;\n',
    );
    const inventory = buildInventory(root);
    const source = inventory.files.find((entry) => entry.path === 'src/index.ts')!;
    const result = validateFragmentDetailed(
      root,
      inventory,
      {
        shard_id: 'map-shard-1',
        module_ids: [source.module_id],
        claims: [
          {
            kind: 'contract',
            statement: 'The module exposes both public entrypoints.',
            evidence: [
              {
                path: source.path,
                symbol: 'publicApi, secondaryApi',
                file_hash: source.file_hash,
              },
            ],
          },
        ],
        gaps: [],
      },
      [source.module_id],
    );

    expect(result.errors).toEqual([]);
    expect(result.fragment?.claims[0]?.evidence.map((entry) => entry.symbol)).toEqual([
      'publicApi',
      'secondaryApi',
    ]);
  });
});

describe('directed codebase context', () => {
  let root: string;

  beforeEach(() => {
    root = tmpProject('rijo-context-');
    const dir = path.join(root, '.rijo', 'codebase');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SUMMARY.md'), '# Summary\n\nAuth and checkout platform.\n');
    fs.writeFileSync(
      path.join(dir, 'inventory.json'),
      JSON.stringify({
        schema_version: 1,
        files: [
          {
            path: 'src/auth/service.ts',
            kind: 'code',
            language: 'TypeScript',
            bytes: 100,
            file_hash: 'a'.repeat(64),
            module_id: 'auth',
            imports: [],
            exports: ['AuthService'],
          },
          {
            path: 'tests/auth.test.ts',
            kind: 'test',
            language: 'TypeScript',
            bytes: 80,
            file_hash: 'b'.repeat(64),
            module_id: 'tests',
            imports: ['../src/auth/service.js'],
            exports: [],
          },
        ],
        excluded_paths: [],
        coverage: { relevant_files_classified: 1 },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'symbols.json'),
      JSON.stringify({
        schema_version: 1,
        symbols: [
          {
            name: 'AuthService.validateSession',
            kind: 'function',
            evidence: { path: 'src/auth/service.ts', lines: '1-5', file_hash: 'a'.repeat(64) },
          },
        ],
      }),
    );
    fs.writeFileSync(path.join(dir, 'surfaces.json'), JSON.stringify({ schema_version: 1, surfaces: [] }));
    fs.writeFileSync(
      path.join(dir, 'dependency-graph.json'),
      JSON.stringify({
        schema_version: 1,
        modules: [
          {
            id: 'auth',
            paths: ['src/auth/service.ts'],
            dependencies: [],
            consumers: ['tests'],
          },
          {
            id: 'tests',
            paths: ['tests/auth.test.ts'],
            dependencies: ['auth'],
            consumers: [],
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'map-state.json'),
      JSON.stringify({
        schema_version: 1,
        mapper_version: '1',
        status: 'COMPLETE',
        mapped_commit: 'abc',
        mapped_tree_hash: 'tree',
        mapped_at: '2026-07-25T00:00:00.000Z',
        branch: 'main',
        source_roots: ['src'],
        module_ids: ['auth'],
        file_count: 1,
        coverage: {},
        excluded_paths: [],
        artifact_hashes: {},
        baseline_status: 'PASSED',
        changed_paths_since_map: [],
        stale_reasons: [],
      }),
    );
  });

  afterEach(() => cleanup(root));

  it('selects matching modules and symbols without loading the whole map and stays inside the byte budget', () => {
    const packet = buildContextPacket(root, 'Alterar validação de sessão no AuthService', 900);
    expect(packet.text).toContain('src/auth/service.ts');
    expect(packet.text).toContain('tests/auth.test.ts');
    expect(packet.text).toContain('AuthService.validateSession');
    expect(packet.selected_modules).toContain('tests');
    expect(packet.bytes).toBeLessThanOrEqual(900);
    expect(packet.files_loaded).not.toContain(path.join(root, '.rijo', 'codebase', 'ARCHITECTURE.md'));
  });

  it('rejects fabricated planner paths, symbols, and hashes before execution', () => {
    fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'auth', 'service.ts'),
      'export function validateSession() { return true; }\n',
    );
    const inventory = buildInventory(root);
    const symbols = extractSymbols(root, inventory);
    fs.writeFileSync(path.join(root, '.rijo', 'codebase', 'inventory.json'), JSON.stringify(inventory));
    fs.writeFileSync(path.join(root, '.rijo', 'codebase', 'symbols.json'), JSON.stringify(symbols));
    const plan = PhasePlanSchema.parse({
      phase: '01',
      tasks: [
        {
          id: 'T01',
          name: 'Use existing auth contract',
          requirement_ids: ['REQ-1'],
          files: ['src/auth/service.ts'],
          mapped_references: [
            {
              path: 'src/auth/service.ts',
              symbol: 'inventedSessionContract',
              file_hash: 'f'.repeat(64),
            },
          ],
          write_scope: ['src/auth/service.ts'],
          tests: [],
          evidence_expected: 'contract remains valid',
        },
        {
          id: 'T02',
          name: 'Add integration',
          technical_justification: 'integration',
          files: ['missing/deep/file.ts'],
          mapped_references: [
            {
              path: 'missing/deep/file.ts',
              file_hash: 'e'.repeat(64),
            },
          ],
          write_scope: ['missing/deep/file.ts'],
          tests: [],
          evidence_expected: 'integration exists',
        },
      ],
    });
    const issues = validatePlanMapReferences(root, plan);
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['MAP_HASH_MISMATCH', 'MAP_SYMBOL_NOT_FOUND', 'MAP_PATH_NOT_FOUND']),
    );
  });

  it('accepts a mapped symbol when the reviewed claim evidence owns it', () => {
    fs.mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'auth', 'service.ts'),
      'export function validateSession() { return true; }\n',
    );
    const inventory = buildInventory(root);
    const authFile = inventory.files.find((entry) => entry.path === 'src/auth/service.ts')!;
    fs.writeFileSync(path.join(root, '.rijo', 'codebase', 'inventory.json'), JSON.stringify(inventory));
    fs.writeFileSync(
      path.join(root, '.rijo', 'codebase', 'claims.json'),
      JSON.stringify({
        schema_version: 1,
        claims: [
          {
            kind: 'contract',
            statement: 'The session validator is the public authentication contract.',
            evidence: [
              {
                path: authFile.path,
                symbol: 'validateSession',
                lines: '1-1',
                file_hash: authFile.file_hash,
              },
            ],
          },
        ],
      }),
    );
    const plan = PhasePlanSchema.parse({
      phase: '01',
      tasks: [
        {
          id: 'T01',
          name: 'Use the mapped validator',
          requirement_ids: ['REQ-1'],
          files: [authFile.path],
          mapped_references: [
            {
              path: authFile.path,
              symbol: 'validateSession',
              file_hash: authFile.file_hash,
            },
          ],
          write_scope: [authFile.path],
          tests: [],
          evidence_expected: 'the mapped contract remains valid',
        },
        {
          id: 'T02',
          name: 'Keep the mapped validator compatible',
          requirement_ids: ['REQ-1'],
          files: [authFile.path],
          mapped_references: [
            {
              path: authFile.path,
              symbol: 'validateSession',
              file_hash: authFile.file_hash,
            },
          ],
          write_scope: [authFile.path],
          tests: [],
          evidence_expected: 'the mapped contract remains compatible',
        },
      ],
    });

    expect(validatePlanMapReferences(root, plan)).toEqual([]);
  });
});

describe('stack and workspace detection', () => {
  let roots: string[] = [];

  afterEach(() => {
    for (const root of roots) cleanup(root);
    roots = [];
  });

  it.each([
    {
      name: 'Python',
      files: {
        'pyproject.toml': '[project]\nname="py-app"\n',
        'src/app.py': 'def main():\n    return True\n',
        'tests/test_app.py': 'def test_app():\n    assert True\n',
      },
      manager: 'pip',
      command: 'pytest',
    },
    {
      name: 'Go',
      files: {
        'go.mod': 'module example.test/app\n\ngo 1.24\n',
        'cmd/api/main.go': 'package main\nfunc main() {}\n',
      },
      manager: 'go',
      command: 'go test ./...',
    },
    {
      name: 'generic',
      files: {
        'src/main.swift': 'public func boot() {}\n',
        'Makefile': 'all:\n\ttrue\n',
      },
      manager: null,
      command: null,
    },
  ])('maps $name without a stack-specific agent', ({ files, manager, command }) => {
    const root = tmpProject('rijo-map-stack-');
    roots.push(root);
    for (const [relative, body] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    const inventory = buildInventory(root);
    expect(inventory.files.length).toBe(Object.keys(files).length);
    if (manager) expect(inventory.package_managers).toContain(manager);
    else expect(inventory.package_managers).toEqual([]);
    if (command) expect(inventory.detected_commands.map((item) => item.command)).toContain(command);
    else expect(inventory.detected_commands).toEqual([]);
  });

  it('detects two apps and shared packages as unique monorepo owners', () => {
    const root = tmpProject('rijo-map-monorepo-');
    roots.push(root);
    const files = {
      'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
      'apps/web/package.json': JSON.stringify({ name: '@repo/web' }),
      'apps/web/src/index.ts': "import { shared } from '../../../packages/shared/src/index.js';\n",
      'apps/api/package.json': JSON.stringify({ name: '@repo/api' }),
      'apps/api/src/index.ts': 'export const api = true;\n',
      'packages/shared/package.json': JSON.stringify({ name: '@repo/shared' }),
      'packages/shared/src/index.ts': 'export const shared = true;\n',
    };
    for (const [relative, body] of Object.entries(files)) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
    const inventory = buildInventory(root);
    expect(inventory.workspace_roots).toEqual(
      expect.arrayContaining(['apps/web', 'apps/api', 'packages/shared']),
    );
    expect(new Set(inventory.files.map((file) => `${file.path}:${file.module_id}`)).size).toBe(inventory.files.length);
  });
});
