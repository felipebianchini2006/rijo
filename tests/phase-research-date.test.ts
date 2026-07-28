import { describe, expect, it } from 'vitest';
import {
  normalizeResearchCheckedAt,
  PhaseResearchPayloadSchema,
} from '../src/workflows/run.js';

function phaseResearchPayload(checkedAt: string) {
  return {
    summary: 'Node.js 24 is Active LTS.',
    volatile_facts: true,
    sources: [{
      claim: 'Node.js 24 is Active LTS',
      source: 'Node.js releases',
      url: 'https://nodejs.org/en/about/previous-releases',
      checked_at: checkedAt,
      version: '24.x',
      tier: 'official',
    }],
  };
}

describe('phase research checked date', () => {
  it('normalizes a documented calendar date to an ISO date-time', () => {
    expect(normalizeResearchCheckedAt('2026-07-27')).toBe('2026-07-27T00:00:00.000Z');
  });

  it('preserves an ISO date-time', () => {
    expect(normalizeResearchCheckedAt('2026-07-27T18:00:00.000Z')).toBe(
      '2026-07-27T18:00:00.000Z',
    );
  });

  it('accepts an ISO date-time with a numeric offset', () => {
    const parsed = PhaseResearchPayloadSchema.parse(
      phaseResearchPayload('2026-07-28T07:34:19-03:00'),
    );

    expect(parsed.sources[0]!.checked_at).toBe('2026-07-28T07:34:19-03:00');
  });

  it('normalizes a calendar date before validation', () => {
    const parsed = PhaseResearchPayloadSchema.parse(phaseResearchPayload('2026-07-27'));

    expect(parsed.sources[0]!.checked_at).toBe('2026-07-27T00:00:00.000Z');
  });

  it('rejects a malformed checked date', () => {
    expect(
      PhaseResearchPayloadSchema.safeParse(phaseResearchPayload('not-a-date')).success,
    ).toBe(false);
  });
});
