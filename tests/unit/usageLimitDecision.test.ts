import { describe, it, expect } from 'vitest';
import { decideUsageLimitChange } from '@/lib/services/invitationAdmin';
import { updateUsageLimitSchema } from '@/lib/validation/schemas';

/**
 * Every rule that keeps a scan-allowance edit from ever causing a scan
 * problem, checked as a pure function (no database needed).
 */
describe('decideUsageLimitChange', () => {
  const card = (status: string, usageCount: number, usageLimit: number | null) => ({ status, usageCount, usageLimit });

  it('increasing an unused card keeps it scannable and moves no counter', () => {
    const d = decideUsageLimitChange(card('unused', 0, 1), 5);
    expect(d).toEqual({ ok: true, nextStatus: 'unused', totalUsedDelta: 0, changed: true });
  });

  it('raising the limit on an EXHAUSTED card reopens it and gives the exhausted-card counter back', () => {
    const d = decideUsageLimitChange(card('used', 1, 1), 3);
    expect(d).toEqual({ ok: true, nextStatus: 'unused', totalUsedDelta: -1, changed: true });
  });

  it('switching an exhausted card to unlimited reopens it', () => {
    const d = decideUsageLimitChange(card('used', 5, 5), null);
    expect(d).toMatchObject({ ok: true, nextStatus: 'unused', totalUsedDelta: -1 });
  });

  it('lowering the limit to exactly the uses consumed LOCKS the card and counts it exhausted', () => {
    const d = decideUsageLimitChange(card('unused', 2, 5), 2);
    expect(d).toEqual({ ok: true, nextStatus: 'used', totalUsedDelta: 1, changed: true });
  });

  it('reducing but staying above the uses consumed keeps it scannable', () => {
    expect(decideUsageLimitChange(card('unused', 1, 10), 4)).toMatchObject({ ok: true, nextStatus: 'unused', totalUsedDelta: 0 });
  });

  it('REFUSES a limit below the uses already consumed (would invalidate past valid scans)', () => {
    const d = decideUsageLimitChange(card('unused', 4, 10), 3);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.code).toBe('BELOW_USED');
      expect(d.message).toContain('4 times');
    }
  });

  it('unlimited (null) is never below the used count', () => {
    expect(decideUsageLimitChange(card('unused', 500, 1000), null)).toMatchObject({ ok: true, nextStatus: 'unused' });
  });

  it('an unlimited card can be capped at or above its used count', () => {
    expect(decideUsageLimitChange(card('unused', 7, null), 7)).toMatchObject({ ok: true, nextStatus: 'used', totalUsedDelta: 1 });
    expect(decideUsageLimitChange(card('unused', 7, null), 20)).toMatchObject({ ok: true, nextStatus: 'unused', totalUsedDelta: 0 });
  });

  it('an already-exhausted card stays exhausted when the new limit still equals its uses (no counter drift)', () => {
    expect(decideUsageLimitChange(card('used', 3, 5), 3)).toEqual({ ok: true, nextStatus: 'used', totalUsedDelta: 0, changed: true });
  });

  it('never edits a revoked card', () => {
    const d = decideUsageLimitChange(card('revoked', 0, 1), 9);
    expect(d).toMatchObject({ ok: false, code: 'REVOKED' });
  });

  it('setting the same limit is an idempotent no-op', () => {
    expect(decideUsageLimitChange(card('unused', 1, 5), 5)).toMatchObject({ ok: true, changed: false, totalUsedDelta: 0 });
  });
});

describe('updateUsageLimitSchema', () => {
  it('accepts whole numbers 1..9999 and null (unlimited)', () => {
    expect(updateUsageLimitSchema.safeParse({ usageLimit: 1 }).success).toBe(true);
    expect(updateUsageLimitSchema.safeParse({ usageLimit: 9999 }).success).toBe(true);
    expect(updateUsageLimitSchema.safeParse({ usageLimit: null }).success).toBe(true);
  });
  it('rejects 0, negatives, decimals, huge values, strings and a missing field', () => {
    for (const bad of [0, -1, 1.5, 10000, '5', undefined]) {
      expect(updateUsageLimitSchema.safeParse({ usageLimit: bad as never }).success).toBe(false);
    }
    expect(updateUsageLimitSchema.safeParse({}).success).toBe(false);
  });
});
