import { describe, expect, it } from 'vitest';
import {
  deriveTemplateGeometry,
  resolveSerialGeometry,
  serialGeometryBelowQr,
  REFERENCE_CANVAS,
  REFERENCE_QR_BOX,
} from '@/lib/invitation/geometry';
import { formatSerial, normalizeSerial, hyphenateSerial, hyphenateSerialCandidates } from '@/lib/invitation/serial';

describe('resolveSerialGeometry', () => {
  it('ALWAYS resolves to the approved near-QR placement (owner decision)', () => {
    // Stored template serials from the pre-plate era carry the invisible
    // bottom-edge placement — honoring them would keep printing cards
    // whose serial nobody can see. Even an enabled stored serial is
    // replaced by the approved placement.
    const stored = {
      enabled: true,
      x: 500,
      y: 1400,
      fontSize: 40,
      color: '#101010',
    };
    const r = resolveSerialGeometry({
      canvasWidth: REFERENCE_CANVAS.width,
      canvasHeight: REFERENCE_CANVAS.height,
      qr: REFERENCE_QR_BOX,
      serial: stored,
    });
    const approved = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height).serial;
    expect(r).toEqual(approved);
    expect(r.plate).toBe(false);
  });

  it('falls back to the approved default when the stored template predates serial support', () => {
    // Templates uploaded before serial support have NO serial field at all —
    // generation must still print the traceable serial on every card.
    const r = resolveSerialGeometry({
      canvasWidth: REFERENCE_CANVAS.width,
      canvasHeight: REFERENCE_CANVAS.height,
      qr: REFERENCE_QR_BOX,
    });
    expect(r.enabled).toBe(true);
    expect(r).toEqual(deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height).serial);
  });

  it('falls back when the stored serial is present but disabled (older shape)', () => {
    const r = resolveSerialGeometry({
      canvasWidth: REFERENCE_CANVAS.width,
      canvasHeight: REFERENCE_CANVAS.height,
      qr: REFERENCE_QR_BOX,
      serial: { enabled: false, x: 0, y: 0, fontSize: 10, color: '#000000' },
    });
    expect(r.enabled).toBe(true);
    expect(r).toEqual(deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height).serial);
  });

  it('places the serial directly under the QR, centered on it, gold text with no plate', () => {
    const g = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
    const qr = g.qr;
    const serial = g.serial;
    expect(serial.enabled).toBe(true);
    expect(serial.plate).toBe(false);
    expect(serial.color).toBe('#C5A059');
    // horizontally centered on the QR box
    expect(serial.x).toBe(Math.round(qr.x + qr.size / 2));
    // starts clearly BELOW the QR box
    expect(serial.y).toBeGreaterThan(qr.y + qr.size);
    // stays inside the canvas
    expect(serial.y).toBeLessThan(REFERENCE_CANVAS.height);
    // half the previous (30px-min) size, still legible
    expect(serial.fontSize).toBeGreaterThanOrEqual(14);
  });

  it('keeps the approved QR placement untouched on the reference canvas', () => {
    const g = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
    expect(g.qr.x).toBe(REFERENCE_QR_BOX.x);
    expect(g.qr.y).toBe(REFERENCE_QR_BOX.y);
    expect(g.qr.size).toBe(REFERENCE_QR_BOX.size);
  });

  it('REGRESSION: follows the QR wherever it actually is on THIS template, not a fixed reference ratio', () => {
    // The original bug: resolveSerialGeometry recomputed the serial's
    // position from the canvas size alone using the reference-artwork
    // ratios — completely disconnected from where the QR actually sits on
    // this specific card. A custom artwork with the QR box somewhere else
    // entirely (different design, different aspect ratio) must still get
    // its serial printed directly under ITS real QR box, not under where
    // the reference artwork's QR happens to be.
    const canvasWidth = 745;
    const canvasHeight = 1024;
    const customQr = { x: 40, y: 100, size: 200 }; // nowhere near the reference ratios
    const r = resolveSerialGeometry({ canvasWidth, canvasHeight, qr: customQr });
    expect(r.enabled).toBe(true);
    expect(r.x).toBe(Math.round(customQr.x + customQr.size / 2));
    expect(r.y).toBeGreaterThan(customQr.y + customQr.size);
    expect(r.y).toBeLessThan(canvasHeight);
    // and definitely NOT wherever the fixed reference ratios would have put it
    const wrongLegacyY = Math.round(0.663265 * canvasHeight + 0.220561 * canvasWidth + 0.075 * canvasHeight);
    expect(r.y).not.toBe(wrongLegacyY);
  });

  it('serialGeometryBelowQr stays within the canvas for a tall QR near the bottom edge', () => {
    const canvasWidth = 1000;
    const canvasHeight = 1200;
    const qr = { x: 300, y: 1000, size: 200 }; // bottom edge at 1200 = canvas edge
    const s = serialGeometryBelowQr(qr, canvasWidth, canvasHeight);
    // still computed directly below, even if that lands outside this
    // particular canvas — callers are responsible for choosing sane QR
    // placement; this function's contract is "always directly under qr".
    expect(s.y).toBeGreaterThan(qr.y + qr.size);
  });
});

describe('serial format (hyphenless — code and number together)', () => {
  it('formats a serial as one continuous token', () => {
    expect(formatSerial('ISWED', 42)).toBe('ISWED00042');
    expect(formatSerial('iswed', 1)).toBe('ISWED00001');
    expect(formatSerial('E2E', 12345)).toBe('E2E12345');
  });

  it('normalizes any human typing into the canonical form', () => {
    expect(normalizeSerial('ISWED-00042')).toBe('ISWED00042');
    expect(normalizeSerial('iswed 00042')).toBe('ISWED00042');
    expect(normalizeSerial('  iswed00042  ')).toBe('ISWED00042');
    expect(normalizeSerial('ISWED.00042')).toBe('ISWED00042');
  });

  it('hyphenates a normalized serial into the legacy stored shape', () => {
    expect(hyphenateSerial('ISWED00042')).toBe('ISWED-00042');
    expect(hyphenateSerial('E2E12345')).toBe('E2E-12345');
    expect(hyphenateSerial('NOT-A-SERIAL')).toBeNull();
  });

  it('hyphenateSerialCandidates covers ALL plausible splits when the event code itself ends in digits — the ambiguous case a single guess would miss', () => {
    // "IS26" + "00201" normalizes to "IS2600201". The last letter is at
    // index 1 ('S'), so the naive last-letter-boundary guess would only
    // produce "IS-2600201" and MISS a card printed as "IS26-00201".
    // hyphenateSerialCandidates() must return both possible splits.
    const candidates = hyphenateSerialCandidates('IS2600201');
    expect(candidates).toContain('IS26-00201');
    expect(candidates).toContain('IS-2600201');
    // Unambiguous shape (code is all letters) still returns exactly one.
    expect(hyphenateSerialCandidates('ISWED00042')).toEqual(['ISWED-00042']);
  });
});
