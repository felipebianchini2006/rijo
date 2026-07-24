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
   * Non-volatile facts never expire; volatile ones expire after the TTL — an
   * expired entry NEVER looks current (use lookupWithMeta for its remains).
   */
  lookup(key: string): CacheEntry | null {
    const meta = this.lookupWithMeta(key);
    return meta && !meta.expired ? meta.entry : null;
  }

  /** The raw entry plus an explicit expiry flag (an expired fact is history, not truth). */
  lookupWithMeta(key: string): { entry: CacheEntry; expired: boolean } | null {
    const entry = this.readCache().find((e) => e.key === key);
    if (!entry) return null;
    if (entry.volatile) {
      const ageDays = (this.now().getTime() - Date.parse(entry.checked_at)) / 86400000;
      if (ageDays > VOLATILE_TTL_DAYS) return { entry, expired: true };
    }
    return { entry, expired: false };
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
   * must cite at least one registered, FRESH source from an official page or a
   * primary advisory. Anything less fails closed — never a silent assumption.
   */
  validateVolatileDecision(claim: string, sourceUrls: string[]): { valid: boolean; reason?: string } {
    if (sourceUrls.length === 0) {
      return { valid: false, reason: `Volatile decision "${claim}" has no verifiable source` };
    }
    const known = new Map(this.readSources().map((s) => [s.url, s]));
    const missing = sourceUrls.filter((u) => !known.has(u));
    if (missing.length > 0) {
      return { valid: false, reason: `Sources not registered in sources.json: ${missing.join(', ')}` };
    }
    const cited = sourceUrls.map((u) => known.get(u)!);
    const fresh = cited.filter((s) => (this.now().getTime() - Date.parse(s.checked_at)) / 86400000 <= VOLATILE_TTL_DAYS);
    if (fresh.length === 0) {
      return { valid: false, reason: `All cited sources for "${claim}" are stale (older than ${VOLATILE_TTL_DAYS} days)` };
    }
    if (!fresh.some((s) => s.tier === 'official' || s.tier === 'advisory')) {
      return { valid: false, reason: `Volatile decision "${claim}" cites no official documentation or primary advisory` };
    }
    return { valid: true };
  }

  /**
   * Long-project hygiene: when sources.json exceeds maxSources, the oldest
   * entries are moved to a timestamped archive file. The active file keeps the
   * newest facts; archives are never consulted as current truth.
   */
  compactSources(maxSources: number): { archived: number; archiveFile: string | null } {
    const sources = this.readSources();
    if (sources.length <= maxSources) return { archived: 0, archiveFile: null };
    const sorted = [...sources].sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
    const toArchive = sorted.slice(0, sources.length - maxSources);
    const keep = sorted.slice(sources.length - maxSources);
    const stamp = this.now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const archiveFile = this.paths.researchSources.replace(/sources\.json$/, `sources-archive-${stamp}.json`);
    writeJsonAtomic(archiveFile, SourcesFileSchema.parse({ sources: toArchive }));
    writeJsonAtomic(this.paths.researchSources, SourcesFileSchema.parse({ sources: keep }));
    return { archived: toArchive.length, archiveFile };
  }
}
