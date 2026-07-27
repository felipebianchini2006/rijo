import { describe, expect, it } from 'vitest';
import { normalizeResearchCheckedAt } from '../src/workflows/run.js';

describe('phase research checked date', () => {
  it('normalizes a documented calendar date to an ISO date-time', () => {
    expect(normalizeResearchCheckedAt('2026-07-27')).toBe('2026-07-27T00:00:00.000Z');
  });

  it('preserves an ISO date-time', () => {
    expect(normalizeResearchCheckedAt('2026-07-27T18:00:00.000Z')).toBe(
      '2026-07-27T18:00:00.000Z',
    );
  });
});
