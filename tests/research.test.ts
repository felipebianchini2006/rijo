import * as fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ResearchStore } from '../src/research/cache.js';
import { RijoPaths } from '../src/core/paths.js';
import { SourceSchema } from '../src/core/schemas/index.js';
import { tmpProject, cleanup } from './helpers.js';

const T0 = new Date('2026-07-23T12:00:00.000Z');
const DAY = 86400000;
const at = (d: Date) => () => d;
const daysLater = (n: number) => new Date(T0.getTime() + n * DAY);

describe('ResearchStore', () => {
  let root: string;
  let paths: RijoPaths;

  beforeEach(() => {
    root = tmpProject();
    paths = new RijoPaths(root);
  });

  afterEach(() => {
    cleanup(root);
  });

  it('store + lookup round trip', () => {
    const store = new ResearchStore(paths, at(T0));
    const stored = store.store({
      key: 'node-lts',
      topic: 'Recommended Node.js LTS',
      summary: 'Node 24 is the Active LTS.',
      volatile: true,
      sources: ['https://nodejs.org/en/about/previous-releases'],
    });
    expect(stored.checked_at).toBe(T0.toISOString());

    const hit = store.lookup('node-lts');
    expect(hit).not.toBeNull();
    expect(hit).toEqual(stored);
    expect(store.lookup('unknown-key')).toBeNull();
  });

  it('volatile entry older than 30 days expires (forces delta research)', () => {
    new ResearchStore(paths, at(T0)).store({
      key: 'node-lts',
      topic: 'Recommended Node.js LTS',
      summary: 'Node 24 is the Active LTS.',
      volatile: true,
      sources: [],
    });

    const fresh = new ResearchStore(paths, at(daysLater(29)));
    expect(fresh.lookup('node-lts')).not.toBeNull();

    const stale = new ResearchStore(paths, at(daysLater(31)));
    expect(stale.lookup('node-lts')).toBeNull();
  });

  it('non-volatile entry never expires', () => {
    new ResearchStore(paths, at(T0)).store({
      key: 'http-semantics',
      topic: 'HTTP status code semantics',
      summary: '404 means not found.',
      volatile: false,
      sources: [],
    });

    const muchLater = new ResearchStore(paths, at(daysLater(3650)));
    const hit = muchLater.lookup('http-semantics');
    expect(hit).not.toBeNull();
    expect(hit!.summary).toBe('404 means not found.');
  });

  it('cache prevents repeat research: lookup keeps hitting the stored entry', () => {
    const store = new ResearchStore(paths, at(T0));
    store.store({
      key: 'topic-a',
      topic: 'Topic A',
      summary: 'first answer',
      volatile: false,
      sources: [],
    });
    // A second run over the same cache file gets the answer without researching.
    const secondRun = new ResearchStore(paths, at(daysLater(1)));
    expect(secondRun.lookup('topic-a')!.summary).toBe('first answer');
    expect(secondRun.lookup('topic-a')!.summary).toBe('first answer');
  });

  describe('validateVolatileDecision', () => {
    const url = 'https://nodejs.org/en/about/previous-releases';

    it('fails without any sources', () => {
      const store = new ResearchStore(paths, at(T0));
      const res = store.validateVolatileDecision('Use Node 24', []);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/no verifiable source/);
    });

    it('fails with urls not registered in sources.json', () => {
      const store = new ResearchStore(paths, at(T0));
      const res = store.validateVolatileDecision('Use Node 24', [url]);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain(url);
    });

    it('passes once an OFFICIAL source is registered', () => {
      const store = new ResearchStore(paths, at(T0));
      store.addSource(
        SourceSchema.parse({
          claim: 'Node.js 24 is Active LTS',
          source: 'nodejs.org previous releases',
          url,
          checked_at: T0.toISOString(),
          confidence: 'high',
          tier: 'official',
        }),
      );
      expect(store.validateVolatileDecision('Use Node 24', [url])).toEqual({ valid: true });
    });

    it('fails closed when only secondary sources are cited', () => {
      const store = new ResearchStore(paths, at(T0));
      store.addSource(
        SourceSchema.parse({
          claim: 'Blog says Node 24 is fine',
          source: 'random blog',
          url,
          checked_at: T0.toISOString(),
          confidence: 'medium',
          tier: 'secondary',
        }),
      );
      const res = store.validateVolatileDecision('Use Node 24', [url]);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/official documentation or primary advisory/);
    });

    it('a stale source never looks current (fails after the TTL)', () => {
      const store = new ResearchStore(paths, at(T0));
      store.addSource(
        SourceSchema.parse({
          claim: 'Node.js 24 is Active LTS',
          source: 'nodejs.org',
          url,
          checked_at: T0.toISOString(),
          confidence: 'high',
          tier: 'official',
        }),
      );
      const later = new Date(T0.getTime() + 40 * 86400000);
      const staleStore = new ResearchStore(paths, at(later));
      const res = staleStore.validateVolatileDecision('Use Node 24', [url]);
      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/stale/);
    });
  });

  describe('compaction and archiving', () => {
    it('archives the oldest sources beyond the limit; the active file keeps the newest', () => {
      const store = new ResearchStore(paths, at(T0));
      for (let i = 0; i < 10; i++) {
        store.addSource(
          SourceSchema.parse({
            claim: `claim ${i}`,
            source: 's',
            url: `https://example.org/${i}`,
            checked_at: new Date(T0.getTime() + i * 86400000).toISOString(),
            confidence: 'high',
            tier: 'official',
          }),
        );
      }
      const result = store.compactSources(4);
      expect(result.archived).toBe(6);
      expect(result.archiveFile).toBeTruthy();
      const remaining = store.readSources();
      expect(remaining).toHaveLength(4);
      // the newest four survive
      expect(remaining.map((s) => s.claim).sort()).toEqual(['claim 6', 'claim 7', 'claim 8', 'claim 9']);
      // archived facts are preserved on disk, never lost
      const archived = JSON.parse(fs.readFileSync(result.archiveFile!, 'utf8')) as { sources: unknown[] };
      expect(archived.sources).toHaveLength(6);
    });
  });
});
