import { describe, expect, it } from 'vitest';
import {
  deriveTemplateGeometry,
  resolveSerialGeometry,
  REFERENCE_CANVAS,
} from '@/lib/invitation/geometry';

describe('resolveSerialGeometry', () => {
  it('keeps an explicitly enabled stored serial geometry', () => {
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
    expect(r).toEqual(stored);
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

  it('scales the default serial overlay to the actual artwork dimensions', () => {
    const r = resolveSerialGeometry({ canvasWidth: 2140, canvasHeight: 2940 });
    expect(r.enabled).toBe(true);
    expect(r.x).toBe(1070); // centered on a 2140px-wide canvas
    expect(r.fontSize).toBeGreaterThan(0);
  });
});
