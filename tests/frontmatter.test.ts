import { describe, it, expect } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from '../src/core/frontmatter.js';

describe('frontmatter', () => {
  it('round-trips data and body through serialize + parse', () => {
    const data = {
      milestone: 'M001',
      count: 2,
      flag: true,
      items: ['a', 'b'],
      nothing: null,
    };
    const body = '# Title\n\nSome body text.\n';
    const serialized = serializeFrontmatter(data, body);
    const parsed = parseFrontmatter<typeof data>(serialized);
    expect(parsed.data).toEqual(data);
    // parse keeps the blank separator line at the head of the body;
    // serialize strips it again, so the round trip is stable at document level
    expect(parsed.body.replace(/^\n+/, '')).toBe(body);
    expect(serializeFrontmatter(parsed.data, parsed.body)).toBe(serialized);
  });

  it('serializes with --- fences and a blank line before the body', () => {
    const out = serializeFrontmatter({ a: 1 }, 'body');
    expect(out).toBe('---\na: 1\n---\n\nbody');
  });

  it('strips leading newlines from the body when serializing', () => {
    const out = serializeFrontmatter({ a: 1 }, '\n\nbody');
    expect(out).toBe('---\na: 1\n---\n\nbody');
  });

  it('returns empty data and the full content when there is no front matter', () => {
    const content = '# Just markdown\n\nNo front matter here.\n';
    const parsed = parseFrontmatter(content);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe(content);
  });

  it('parses CRLF front matter fences', () => {
    const content = '---\r\nkey: value\r\n---\r\nbody';
    const parsed = parseFrontmatter<{ key: string }>(content);
    expect(parsed.data).toEqual({ key: 'value' });
    expect(parsed.body).toBe('body');
  });
});
