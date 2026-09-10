import { describe, expect, it } from 'vitest';
import { generateQrToken, isPlausibleToken } from '@/lib/qr/token';
import { digestToken, safeEqual } from '@/lib/qr/digest';
import { normalizeSerial, formatSerial, eventCodeFromSlug } from '@/lib/invitation/serial';
import { deriveTemplateGeometry, REFERENCE_CANVAS, REFERENCE_QR_BOX } from '@/lib/invitation/geometry';

describe('QR credential generation', () => {
  it('uses the IS26 version prefix with 32 url-safe random bytes', () => {
    const t = generateQrToken();
    expect(t.startsWith('IS26.')).toBe(true);
    expect(isPlausibleToken(t)).toBe(true);
    // 32 bytes -> 43 base64url chars, no padding
    expect(t.split('.')[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never generates duplicates (10k tokens)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) seen.add(generateQrToken());
    expect(seen.size).toBe(10000);
  });

  it('plausibility check rejects non-credentials', () => {
    expect(isPlausibleToken('hello')).toBe(false);
    expect(isPlausibleToken('IS26.short')).toBe(false);
    expect(isPlausibleToken('IS26.' + 'A'.repeat(500))).toBe(false);
  });
});

describe('token digests', () => {
  it('is deterministic 64-char hex', () => {
    const t = generateQrToken();
    const a = digestToken(t);
    const b = digestToken(t);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs per token (no collisions across 10k)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10000; i++) seen.add(digestToken(generateQrToken()));
    expect(seen.size).toBe(10000);
  });

  it('safeEqual compares without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('serial numbers', () => {
  it('formats as <CODE><5 digits> — one continuous token, no hyphen (owner decision)', () => {
    expect(formatSerial('ISWED', 1)).toBe('ISWED00001');
    expect(formatSerial('iswed', 42)).toBe('ISWED00042');
    expect(formatSerial('ISWED', 12345)).toBe('ISWED12345');
  });
  it('normalizes any human typing to the canonical hyphenless form', () => {
    expect(normalizeSerial('  iswed-00042 ')).toBe('ISWED00042');
    expect(normalizeSerial('iswed 00042')).toBe('ISWED00042');
    expect(normalizeSerial('ISWED.00042')).toBe('ISWED00042');
  });
  it('derives event code from slug', () => {
    expect(eventCodeFromSlug('is-wedding-2026')).toBe('ISWED');
    expect(eventCodeFromSlug('birthday-party')).toBe('BIRTH');
  });
});

describe('QR placement geometry', () => {
  it('reproduces the approved 1070x1470 reference box exactly', () => {
    const g = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
    expect(g.qr.x).toBe(REFERENCE_QR_BOX.x);
    expect(g.qr.y).toBe(REFERENCE_QR_BOX.y);
    expect(g.qr.size).toBe(REFERENCE_QR_BOX.size);
    expect(g.qr.size).toBeGreaterThan(200); // ~236px min
  });

  it('scales proportionally to any artwork resolution and stays square', () => {
    for (const [w, h] of [[2140, 2940], [3000, 4121], [1000, 1500]] as [number, number][]) {
      const g = deriveTemplateGeometry(w, h);
      expect(g.qr.x).toBeCloseTo(0.390654 * w, -2);
      expect(g.qr.y).toBeCloseTo(0.663265 * h, -2);
      expect(Math.abs(g.qr.size - Math.round(0.220561 * w))).toBeLessThanOrEqual(1);
    }
  });
});
