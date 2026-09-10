import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { renderInvitationImage } from '@/lib/invitation/render';
import { deriveTemplateGeometry } from '@/lib/invitation/geometry';
import { measureSerialWidth, serialToSvgPaths } from '@/lib/invitation/serialGlyphs';

/**
 * The serial must actually appear as INK on the card. This regression guards
 * the production failure where SVG <text> rendered through fontconfig came
 * out BLANK on Vercel (no usable fonts in the serverless image) — every
 * card had a white plate with an invisible serial. The serial is now drawn
 * as vector paths, which need no fonts, so the ink assertion below must hold
 * on every host.
 */
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

  it('renders a card whose serial band actually contains dark ink pixels', async () => {
    // plain white 1070x1470 template, approved geometry
    const template = await sharp({
      create: { width: 1070, height: 1470, channels: 3, background: '#ffffff' },
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
    // crop the serial band: from just above the plate top to below the baseline
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

    let dark = 0;
    for (const v of band) if (v < 80) dark++;
    // thousands of glyph ink pixels must be present in the band
    expect(dark).toBeGreaterThan(200);
  });

  it('renders the serial band with ink even when the template is mid-grey (plate contrast)', async () => {
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
    let dark = 0;
    for (const v of band) if (v < 80) dark++;
    expect(dark).toBeGreaterThan(200);
  });
});
