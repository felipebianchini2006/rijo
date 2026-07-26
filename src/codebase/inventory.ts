import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '../core/fsx.js';
import { isSensitivePath } from '../security/sensitive.js';
import {
  CODEBASE_SCHEMA_VERSION,
  InventoryDocumentSchema,
  type CodebaseInventoryEntry,
  type ExcludedPath,
  type InventoryDocument,
  type InventoryKind,
} from './schemas.js';

const MAX_FILE_BYTES = 1024 * 1024;
const VENDOR_DIRS = new Set(['node_modules', 'vendor']);
const GENERATED_DIRS = new Set([
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.cache',
  '.turbo',
  'target',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]);
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
]);
const MANIFEST_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
]);
const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
]);

export class MapPreflightError extends Error {
  constructor(
    message: string,
    public readonly code: 'SYMLINK_ESCAPE' | 'UNREADABLE_PATH' | 'INVENTORY_LIMIT',
    public readonly paths: string[] = [],
  ) {
    super(message);
    this.name = 'MapPreflightError';
  }
}

function posix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && !rel.split(path.sep).includes('..'));
}

function moduleId(rel: string): string {
  const parts = rel.split('/');
  if ((parts[0] === 'apps' || parts[0] === 'packages') && parts[1]) return `${parts[0]}/${parts[1]}`;
  if ((parts[0] === 'src' || parts[0] === 'lib' || parts[0] === 'cmd' || parts[0] === 'internal') && parts[1]) {
    return `${parts[0]}/${parts[1].replace(/\.[^.]+$/, '')}`;
  }
  if (parts[0] === 'tests' || parts[0] === 'test' || parts[0] === '__tests__') return 'tests';
  return parts[0]?.replace(/\.[^.]+$/, '') || 'root';
}

function languageFor(rel: string): string | null {
  const ext = path.extname(rel).toLowerCase();
  const byExt: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.cs': 'C#',
    '.swift': 'Swift',
    '.sql': 'SQL',
    '.sh': 'Shell',
    '.ps1': 'PowerShell',
  };
  return byExt[ext] ?? null;
}

function classify(rel: string): InventoryKind {
  const lower = rel.toLowerCase();
  const base = path.posix.basename(lower);
  if (
    /(^|\/)(migrations?|prisma\/migrations|supabase\/migrations|drizzle\/migrations)(\/|$)/.test(lower) ||
    /\.sql$/.test(lower)
  ) {
    return 'migration';
  }
  if (
    /(^|\/)(__tests__|tests?|spec)(\/|$)/.test(lower) ||
    /\.(test|spec)\.[^.]+$/.test(lower) ||
    /_test\.go$/.test(lower)
  ) {
    return 'test';
  }
  if (/\.(md|mdx|rst|adoc|txt)$/.test(lower)) return 'documentation';
  if (/\.(sh|bash|zsh|ps1|bat|cmd)$/.test(lower) || /(^|\/)scripts?\//.test(lower)) return 'script';
  if (
    MANIFEST_NAMES.has(path.posix.basename(rel)) ||
    LOCKFILE_NAMES.has(path.posix.basename(rel)) ||
    /(^|\/)(\.github|config|configs)(\/|$)/.test(lower) ||
    /(?:^|\.)(config|rc)\.[^.]+$/.test(base) ||
    /\.(json|ya?ml|toml|ini|xml)$/.test(lower)
  ) {
    return 'configuration';
  }
  if (/\.(css|scss|sass|less|svg|html)$/.test(lower) || /(^|\/)(assets?|public|static)(\/|$)/.test(lower)) {
    return 'asset';
  }
  return 'code';
}

function extractImports(content: string, language: string | null): string[] {
  const found = new Set<string>();
  if (language === 'TypeScript' || language === 'JavaScript') {
    for (const match of content.matchAll(/(?:import[\s\S]*?\sfrom\s|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (match[1]) found.add(match[1]);
    }
  } else if (language === 'Python') {
    for (const match of content.matchAll(/^(?:from|import)\s+([A-Za-z0-9_.]+)/gm)) if (match[1]) found.add(match[1]);
  } else if (language === 'Go') {
    for (const match of content.matchAll(/^\s*"([^"]+)"\s*$/gm)) if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

function extractExports(content: string, language: string | null): string[] {
  const found = new Set<string>();
  if (language === 'TypeScript' || language === 'JavaScript') {
    for (const match of content.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      if (match[1]) found.add(match[1]);
    }
    for (const match of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
      for (const part of (match[1] ?? '').split(',')) {
        const name = part.trim().split(/\s+as\s+/)[1] ?? part.trim().split(/\s+as\s+/)[0];
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) found.add(name);
      }
    }
  } else if (language === 'Python') {
    for (const match of content.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) {
      if (match[1] && !match[1].startsWith('_')) found.add(match[1]);
    }
  } else if (language === 'Go') {
    for (const match of content.matchAll(/^(?:func|type|var|const)\s+([A-Z]\w*)/gm)) if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

function commandsFromManifest(root: string, rel: string, content: string): InventoryDocument['detected_commands'] {
  const out: InventoryDocument['detected_commands'] = [];
  const base = path.posix.basename(rel);
  if (base === 'package.json') {
    try {
      const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
      for (const category of ['format:check', 'lint', 'typecheck', 'test', 'build']) {
        if (parsed.scripts?.[category]) out.push({ category, command: `npm run ${category}`, source: rel });
      }
    } catch {
      /* the inventory still records an unparseable manifest */
    }
  } else if (base === 'pyproject.toml' || base === 'requirements.txt') {
    if (fs.existsSync(path.join(root, 'tests'))) out.push({ category: 'test', command: 'pytest', source: rel });
  } else if (base === 'go.mod') {
    out.push({ category: 'test', command: 'go test ./...', source: rel });
    out.push({ category: 'build', command: 'go build ./...', source: rel });
  } else if (base === 'Cargo.toml') {
    out.push({ category: 'test', command: 'cargo test', source: rel });
    out.push({ category: 'build', command: 'cargo build', source: rel });
  }
  return out;
}

function packageManager(manifests: string[], lockfiles: string[]): string[] {
  const out = new Set<string>();
  if (lockfiles.some((p) => p.endsWith('pnpm-lock.yaml'))) out.add('pnpm');
  else if (lockfiles.some((p) => p.endsWith('yarn.lock'))) out.add('yarn');
  else if (lockfiles.some((p) => /bun\.lockb?$/.test(p))) out.add('bun');
  else if (manifests.some((p) => p.endsWith('package.json'))) out.add('npm');
  if (lockfiles.some((p) => p.endsWith('uv.lock'))) out.add('uv');
  else if (lockfiles.some((p) => p.endsWith('poetry.lock'))) out.add('poetry');
  else if (manifests.some((p) => p.endsWith('pyproject.toml') || p.endsWith('requirements.txt'))) out.add('pip');
  if (manifests.some((p) => p.endsWith('go.mod'))) out.add('go');
  if (manifests.some((p) => p.endsWith('Cargo.toml'))) out.add('cargo');
  return [...out];
}

export function buildInventory(projectRoot: string, maxEntries = 50_000): InventoryDocument {
  const root = fs.realpathSync(projectRoot);
  const files: CodebaseInventoryEntry[] = [];
  const excluded: ExcludedPath[] = [];
  const manifests: string[] = [];
  const lockfiles: string[] = [];
  const commands: InventoryDocument['detected_commands'] = [];
  const workspaces = new Set<string>();
  let visited = 0;

  const exclude = (rel: string, reason: ExcludedPath['reason']): void => {
    excluded.push({ path: rel, reason });
  };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      throw new MapPreflightError(`Unreadable repository path: ${posix(path.relative(root, dir))}`, 'UNREADABLE_PATH', [
        posix(path.relative(root, dir)),
      ]);
    }
    for (const entry of entries) {
      if (++visited > maxEntries) throw new MapPreflightError(`Inventory limit exceeded (${maxEntries} entries).`, 'INVENTORY_LIMIT');
      const absolute = path.join(dir, entry.name);
      const rel = posix(path.relative(root, absolute));
      if (rel === '.git') {
        exclude(rel, 'rijo_artifact');
        continue;
      }
      if (rel === '.rijo' || rel.startsWith('.rijo/')) {
        if (entry.isDirectory() && rel === '.rijo') exclude(rel, 'rijo_artifact');
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        const resolved = path.resolve(path.dirname(absolute), target);
        if (path.isAbsolute(target) || !inside(root, resolved)) {
          throw new MapPreflightError(`Repository symlink escapes the project root: ${rel}`, 'SYMLINK_ESCAPE', [rel]);
        }
        exclude(rel, 'symlink');
        continue;
      }
      if (entry.isDirectory()) {
        if (VENDOR_DIRS.has(entry.name)) {
          exclude(rel, 'vendor');
          continue;
        }
        if (GENERATED_DIRS.has(entry.name)) {
          exclude(rel, 'generated');
          continue;
        }
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitivePath(rel)) {
        exclude(rel, 'sensitive');
        continue;
      }
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_FILE_BYTES) {
        exclude(rel, 'large_file');
        continue;
      }
      if (BINARY_EXTENSIONS.has(path.extname(rel).toLowerCase())) {
        exclude(rel, 'binary');
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(absolute);
      } catch {
        exclude(rel, 'unreadable');
        continue;
      }
      if (buffer.includes(0)) {
        exclude(rel, 'binary');
        continue;
      }
      const content = buffer.toString('utf8');
      const language = languageFor(rel);
      const item: CodebaseInventoryEntry = {
        path: rel,
        kind: classify(rel),
        language,
        bytes: stat.size,
        file_hash: sha256(buffer),
        module_id: moduleId(rel),
        imports: extractImports(content, language),
        exports: extractExports(content, language),
      };
      files.push(item);
      if (MANIFEST_NAMES.has(path.posix.basename(rel))) {
        manifests.push(rel);
        commands.push(...commandsFromManifest(root, rel, content));
      }
      if (LOCKFILE_NAMES.has(path.posix.basename(rel))) lockfiles.push(rel);
      if ((rel.startsWith('apps/') || rel.startsWith('packages/')) && rel.split('/')[1]) {
        workspaces.add(rel.split('/').slice(0, 2).join('/'));
      }
    }
  };
  walk(root);

  const sourceRoots = [...new Set(files.filter((f) => ['code', 'test', 'migration'].includes(f.kind)).map((f) => f.path.split('/')[0]!))].sort();
  const entrypoints = files.filter((f) => /(^|\/)(index|main|app|server|cli)\.[^.]+$/.test(f.path));
  const relevantExclusions = excluded.filter((item) => item.reason === 'large_file' || item.reason === 'unreadable');
  const classifiedRatio =
    files.length + relevantExclusions.length === 0
      ? 0
      : files.length / (files.length + relevantExclusions.length);

  return InventoryDocumentSchema.parse({
    schema_version: CODEBASE_SCHEMA_VERSION,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    excluded_paths: excluded.sort((a, b) => a.path.localeCompare(b.path)),
    source_roots: sourceRoots,
    workspace_roots: [...workspaces].sort(),
    manifests: manifests.sort(),
    lockfiles: lockfiles.sort(),
    package_managers: packageManager(manifests, lockfiles),
    detected_commands: [...new Map(commands.map((c) => [c.command, c])).values()],
    coverage: {
      relevant_files_classified: classifiedRatio,
      entrypoints_covered: entrypoints.length === 0 ? 1 : 0,
      modules_covered: 0,
      public_contracts_covered: 0,
      surfaces_covered: 0,
      data_covered: 0,
      tests_operations_covered: 0,
      claims_verified: 0,
    },
  });
}
