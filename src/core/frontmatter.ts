import YAML from 'yaml';

/**
 * Markdown documents with YAML front matter are the canonical machine-readable
 * artifact format. The body stays human-readable; the front matter is data.
 */
export interface FrontmatterDoc<T = Record<string, unknown>> {
  data: T;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter<T = Record<string, unknown>>(content: string): FrontmatterDoc<T> {
  const m = content.match(FM_RE);
  if (!m) return { data: {} as T, body: content };
  const data = (YAML.parse(m[1] ?? '') ?? {}) as T;
  return { data, body: content.slice(m[0].length) };
}

export function serializeFrontmatter<T>(data: T, body: string): string {
  const yaml = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}
