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

    it('passes once the source is registered', () => {
      const store = new ResearchStore(paths, at(T0));
      store.addSource(
        SourceSchema.parse({
          claim: 'Node.js 24 is Active LTS',
          source: 'nodejs.org previous releases',
          url,
          checked_at: T0.toISOString(),
          confidence: 'high',
        }),
      );
      expect(store.validateVolatileDecision('Use Node 24', [url])).toEqual({ valid: true });
    });
  });
});
