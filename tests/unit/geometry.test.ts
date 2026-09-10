import { describe, expect, it } from 'vitest';
import {
  deriveTemplateGeometry,
  resolveSerialGeometry,
  REFERENCE_CANVAS,
  REFERENCE_QR_BOX,
} from '@/lib/invitation/geometry';
import { formatSerial, normalizeSerial, hyphenateSerial } from '@/lib/invitation/serial';

describe('resolveSerialGeometry', () => {
  it('ALWAYS resolves to the approved near-QR plate placement (owner decision)', () => {
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
      serial: stored,
    });
    const approved = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height).serial;
    expect(r).toEqual(approved);
    expect(r.plate).toBe(true);
  });

  it('falls back to the approved default when the stored template predates serial support', () => {
    // Templates uploaded before serial support have NO serial field at all —
    // generation must still print the traceable serial on every card.
    const r = resolveSerialGeometry({
      canvasWidth: REFERENCE_CANVAS.width,
      canvasHeight: REFERENCE_CANVAS.height,
    });
    expect(r.enabled).toBe(true);
    expect(r).toEqual(deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height).serial);
  });

  it('falls back when the stored serial is present but disabled (older shape)', () => {
    const r = resolveSerialGeometry({
      canvasWidth: REFERENCE_CANVAS.width,
      canvasHeight: REFERENCE_CANVAS.height,
      serial: { enabled: false, x: 0, y: 0, fontSize: 10, color: '#000000' },
    });
    expect(r.enabled).toBe(true);
    expect(r).toEqual(deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height).serial);
  });

  it('places the serial directly under the QR, centered on it, on a white plate', () => {
    const g = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
    const qr = g.qr;
    const serial = g.serial;
    expect(serial.enabled).toBe(true);
    expect(serial.plate).toBe(true);
    // horizontally centered on the QR box
    expect(serial.x).toBe(Math.round(qr.x + qr.size / 2));
    // starts clearly BELOW the QR box (plate never overlaps the code)
    expect(serial.y).toBeGreaterThan(qr.y + qr.size);
    // stays inside the canvas
    expect(serial.y).toBeLessThan(REFERENCE_CANVAS.height);
    // large enough to be read by a human
    expect(serial.fontSize).toBeGreaterThanOrEqual(30);
  });

  it('keeps the approved QR placement untouched on the reference canvas', () => {
    const g = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
    expect(g.qr.x).toBe(REFERENCE_QR_BOX.x);
    expect(g.qr.y).toBe(REFERENCE_QR_BOX.y);
    expect(g.qr.size).toBe(REFERENCE_QR_BOX.size);
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
});
