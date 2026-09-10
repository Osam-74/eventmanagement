import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { renderInvitationImage, fitSerialFontSize } from '@/lib/invitation/render';
import { deriveTemplateGeometry } from '@/lib/invitation/geometry';
import { measureSerialWidth, serialToSvgPaths } from '@/lib/invitation/serialGlyphs';

/**
 * The serial must actually appear as INK on the card. This regression guards
 * the production failure where SVG <text> rendered through fontconfig came
 * out BLANK on Vercel (no usable fonts in the serverless image) — every
 * card had an invisible serial. The serial is now drawn as vector paths,
 * which need no fonts, so the ink assertion below must hold on every host.
 *
 * Ink detection is done by DELTA from the sampled background grey, not an
 * absolute "dark pixel" threshold — the approved serial color is gold
 * (#C5A059, owner decision 2026-09-10, no plate), which is a mid-tone and
 * would never trip an absolute darkness check. A delta-based check still
 * catches the real regression (glyphs silently not painted at all) on any
 * background/ink color combination.
 */
function countInkPixels(band: Buffer, backgroundGrey: number, delta = 40): number {
  let ink = 0;
  for (const v of band) if (Math.abs(v - backgroundGrey) > delta) ink++;
  return ink;
}

describe('serial rendering on invitation cards', () => {
  it('measureSerialWidth returns a positive width for a real serial', () => {
    const w = measureSerialWidth('IS26-00042', 34, 3);
    expect(w).toBeGreaterThan(100);
  });

  it('serialToSvgPaths draws one path per known glyph and skips unknowns safely', () => {
    const svg = serialToSvgPaths('IS26-00042', 100, 100, 34, 3, '#111111');
    expect((svg.match(/<path /g) ?? []).length).toBe(10);
    expect(() => serialToSvgPaths('IS26 00042', 100, 100, 34, 3, '#111111')).not.toThrow();
  });

  it('fitSerialFontSize leaves a normal serial completely untouched', () => {
    const fitted = fitSerialFontSize('IS26-00042', 34, 500);
    expect(fitted.fontSize).toBe(34);
    expect(fitted.letterSpacing).toBe(Math.round(34 * 0.08));
  });

  it('fitSerialFontSize shrinks (never below half) a custom tag wider than the allowed width', () => {
    const longTag = 'GRANDPARENTS TABLE ONE AND TWO';
    const unshrunkWidth = measureSerialWidth(longTag, 34, Math.round(34 * 0.08));
    const maxTextW = unshrunkWidth * 0.5; // force shrinking to kick in
    const fitted = fitSerialFontSize(longTag, 34, maxTextW);
    expect(fitted.fontSize).toBeLessThan(34);
    expect(fitted.fontSize).toBeGreaterThanOrEqual(17); // floor: never shrinks past half
    expect(fitted.textW).toBeLessThanOrEqual(unshrunkWidth);
  });

  it('renders a long custom tag on a real card without crashing or producing a malformed image', async () => {
    const template = await sharp({
      create: { width: 1070, height: 1470, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    const geometry = deriveTemplateGeometry(1070, 1470);
    const { buffer } = await renderInvitationImage({
      templateBuffer: template,
      geometry,
      qrToken: 'IS26.LONGTAGSHRINKTESTTOKEN00000000000000000000',
      serial: 'GRANDPARENTS TABLE ONE',
      profile: 'share',
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  });

  it('renders a card whose serial band actually contains ink pixels distinct from the background', async () => {
    // plain white 1070x1470 template, approved geometry
    const bgHex = '#ffffff';
    const template = await sharp({
      create: { width: 1070, height: 1470, channels: 3, background: bgHex },
    })
      .jpeg()
      .toBuffer();
    const geometry = deriveTemplateGeometry(1070, 1470);
    const serial = 'IS26-00042';

    const { buffer, width, height } = await renderInvitationImage({
      templateBuffer: template,
      geometry,
      qrToken: 'IS26.SERIALRENDERTESTTOKEN0000000000000000000',
      serial,
      profile: 'share',
    });
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);

    const scale = width / geometry.canvasWidth;
    const fontSize = geometry.serial.fontSize * scale;
    const sy = geometry.serial.y * scale;
    // crop the serial band: from just above the text top to below the baseline
    const band = await sharp(buffer)
      .extract({
        left: Math.max(0, Math.round(geometry.serial.x * scale - fontSize * 8)),
        top: Math.round(sy - fontSize * 1.3),
        width: Math.round(fontSize * 16),
        height: Math.round(fontSize * 1.7),
      })
      .greyscale()
      .raw()
      .toBuffer();

    // background is pure white -> grey 255
    const ink = countInkPixels(band, 255);
    // thousands of glyph ink pixels must be present in the band
    expect(ink).toBeGreaterThan(200);
  });

  it('renders visible ink on a mid-grey template too (no plate — gold ink must still paint on any background)', async () => {
    const template = await sharp({
      create: { width: 1070, height: 1470, channels: 3, background: '#777777' },
    })
      .jpeg()
      .toBuffer();
    const geometry = deriveTemplateGeometry(1070, 1470);
    const { buffer, width } = await renderInvitationImage({
      templateBuffer: template,
      geometry,
      qrToken: 'IS26.PLATECONTRASTTESTTOKEN000000000000000000000',
      serial: 'IS26-00043',
      profile: 'share',
    });
    const scale = width / geometry.canvasWidth;
    const fontSize = geometry.serial.fontSize * scale;
    const sy = geometry.serial.y * scale;
    const band = await sharp(buffer)
      .extract({
        left: Math.max(0, Math.round(geometry.serial.x * scale - fontSize * 8)),
        top: Math.round(sy - fontSize * 1.3),
        width: Math.round(fontSize * 16),
        height: Math.round(fontSize * 1.7),
      })
      .greyscale()
      .raw()
      .toBuffer();
    // #777777 greyscale ≈ 119
    const ink = countInkPixels(band, 119);
    expect(ink).toBeGreaterThan(200);
  });
});
