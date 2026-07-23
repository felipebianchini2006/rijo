import { z } from 'zod';
import { SourceSchema, type ResearchSource } from '../core/schemas/index.js';
import { readJsonIfExists, writeJsonAtomic } from '../core/fsx.js';
import type { RijoPaths } from '../core/paths.js';

const CacheEntrySchema = z.object({
  key: z.string(),
  topic: z.string(),
  summary: z.string(),
  checked_at: z.string(),
  volatile: z.boolean().default(false),
  sources: z.array(z.string()).default([]),
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;

const CacheFileSchema = z.object({ entries: z.array(CacheEntrySchema) });
const SourcesFileSchema = z.object({ sources: z.array(SourceSchema) });

/** How long a volatile research fact stays valid before delta revalidation. */
const VOLATILE_TTL_DAYS = 30;

export class ResearchStore {
  constructor(
    private readonly paths: RijoPaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private readCache(): CacheEntry[] {
    const raw = readJsonIfExists<unknown>(this.paths.researchCache);
    if (!raw) return [];
    const parsed = CacheFileSchema.safeParse(raw);
    return parsed.success ? parsed.data.entries : [];
  }

  private writeCache(entries: CacheEntry[]): void {
    writeJsonAtomic(this.paths.researchCache, CacheFileSchema.parse({ entries }));
  }

  readSources(): ResearchSource[] {
    const raw = readJsonIfExists<unknown>(this.paths.researchSources);
    if (!raw) return [];
    const parsed = SourcesFileSchema.safeParse(raw);
    return parsed.success ? parsed.data.sources : [];
  }

  addSource(source: ResearchSource): void {
    const sources = this.readSources();
    sources.push(SourceSchema.parse(source));
    writeJsonAtomic(this.paths.researchSources, SourcesFileSchema.parse({ sources }));
  }

  /**
   * Returns a valid cache entry, or null when research is needed.
   * Non-volatile facts never expire; volatile ones expire after the TTL.
   */
  lookup(key: string): CacheEntry | null {
    const entry = this.readCache().find((e) => e.key === key);
    if (!entry) return null;
    if (entry.volatile) {
      const ageDays = (this.now().getTime() - Date.parse(entry.checked_at)) / 86400000;
      if (ageDays > VOLATILE_TTL_DAYS) return null;
    }
    return entry;
  }

  store(entry: Omit<CacheEntry, 'checked_at'>): CacheEntry {
    const entries = this.readCache().filter((e) => e.key !== entry.key);
    const full = CacheEntrySchema.parse({ ...entry, checked_at: this.now().toISOString() });
    entries.push(full);
    this.writeCache(entries);
    return full;
  }

  /**
   * A volatile decision (version pick, security posture, compatibility claim)
   * must cite at least one source with url and checked_at.
   */
  validateVolatileDecision(claim: string, sourceUrls: string[]): { valid: boolean; reason?: string } {
    if (sourceUrls.length === 0) {
      return { valid: false, reason: `Volatile decision "${claim}" has no verifiable source` };
    }
    const known = new Set(this.readSources().map((s) => s.url));
    const missing = sourceUrls.filter((u) => !known.has(u));
    if (missing.length > 0) {
      return { valid: false, reason: `Sources not registered in sources.json: ${missing.join(', ')}` };
    }
    return { valid: true };
  }
}
