import { describe, expect, it } from 'vitest';
import { generateBatchSchema } from '@/lib/validation/schemas';

describe('generateBatchSchema — Card Type (owner request, 2026-09-12)', () => {
  it('defaults cardType to "regular" when omitted (backward compatible with existing clients)', () => {
    const res = generateBatchSchema.safeParse({ eventId: 'event1234', quantity: 5, profile: 'share' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.cardType).toBe('regular');
  });

  it('Regular does not require a tag', () => {
    const res = generateBatchSchema.safeParse({
      eventId: 'event1234', quantity: 5, profile: 'share', cardType: 'regular',
    });
    expect(res.success).toBe(true);
  });

  it('Special REQUIRES a non-empty tag', () => {
    const res = generateBatchSchema.safeParse({
      eventId: 'event1234', quantity: 5, profile: 'share', cardType: 'special',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path).toEqual(['tag']);
    }
  });

  it('Special with only whitespace as the tag is still rejected as empty', () => {
    const res = generateBatchSchema.safeParse({
      eventId: 'event1234', quantity: 5, profile: 'share', cardType: 'special', tag: '   ',
    });
    expect(res.success).toBe(false);
  });

  it('Special with a real tag passes', () => {
    const res = generateBatchSchema.safeParse({
      eventId: 'event1234', quantity: 5, profile: 'share', cardType: 'special', tag: 'VIP',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.tag).toBe('VIP');
  });

  it('rejects an unknown cardType value', () => {
    const res = generateBatchSchema.safeParse({
      eventId: 'event1234', quantity: 5, profile: 'share', cardType: 'vip-lounge',
    });
    expect(res.success).toBe(false);
  });
});
