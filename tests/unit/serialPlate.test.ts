import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { renderInvitationImage, fitSerialFontSize, serialPlateRect, SERIAL_PLATE_RADIUS_RATIO } from '@/lib/invitation/render';
import { deriveTemplateGeometry, SERIAL_GREEN } from '@/lib/invitation/geometry';
import { measureSerialWidth } from '@/lib/invitation/serialGlyphs';

/**
 * Owner restyle 2026-09-28: the serial / tag is GREEN text on a WHITE plate
 * with a 15% corner radius, and the plate must fit any tag length.
 */
describe('serial plate styling', () => {
  it('the approved geometry is green text with the plate enabled', () => {
    const g = deriveTemplateGeometry(1070, 1470).serial;
    expect(g.color).toBe(SERIAL_GREEN);
    expect(g.plate).toBe(true);
    // a real green: green channel clearly dominates
    const [r, gr, b] = [1, 3, 5].map((i) => parseInt(SERIAL_GREEN.slice(i, i + 2), 16));
    expect(gr).toBeGreaterThan(r + 40);
    expect(gr).toBeGreaterThan(b + 40);
  });

  it('corner radius is exactly 15% of the plate height', () => {
    expect(SERIAL_PLATE_RADIUS_RATIO).toBe(0.15);
    for (const fontSize of [16, 21, 42, 63, 120]) {
      const r = serialPlateRect(500, 900, fontSize, 300);
      expect(r.rx).toBe(Math.round(r.h * 0.15));
    }
  });

  it('the plate ALWAYS covers the text horizontally, for short serials and the longest allowed tag', () => {
    const samples = ['VIP', 'IS26-00042', 'FAMILY', 'GRANDPARENTS TABLE ONE', 'A'.repeat(24), 'WWWWWWWWWWWWWWWWWWWWWWWW'];
    for (const text of samples) {
      for (const [fontSize, maxW] of [[21, 250], [63, 750], [21, 5000]] as const) {
        const fit = fitSerialFontSize(text, fontSize, maxW);
        const plate = serialPlateRect(535, 900, fit.fontSize, fit.textW);
        const textLeft = 535 - fit.textW / 2;
        const textRight = 535 + fit.textW / 2;
        expect(plate.x).toBeLessThanOrEqual(textLeft);
        expect(plate.x + plate.w).toBeGreaterThanOrEqual(textRight);
        // and has real side padding, not a hairline fit
        expect(plate.w - fit.textW).toBeGreaterThan(fit.fontSize);
      }
    }
  });

  it('a longer tag gets a wider plate than a short one (background follows the text)', () => {
    const short = fitSerialFontSize('VIP', 21, 5000);
    const long = fitSerialFontSize('GRANDPARENTS TABLE ONE', 21, 5000);
    expect(serialPlateRect(500, 900, long.fontSize, long.textW).w).toBeGreaterThan(
      serialPlateRect(500, 900, short.fontSize, short.textW).w
    );
  });

  it('the widest allowed tag still fits inside the card (never spills off the canvas)', () => {
    const W = 1070;
    const g = deriveTemplateGeometry(W, 1470);
    const worst = 'W'.repeat(24);
    const fit = fitSerialFontSize(worst, g.serial.fontSize, g.qr.size * 1.6);
    const plate = serialPlateRect(g.serial.x, g.serial.y, fit.fontSize, fit.textW);
    expect(plate.x).toBeGreaterThanOrEqual(0);
    expect(plate.x + plate.w).toBeLessThanOrEqual(W);
  });

  async function renderCard(text: string) {
    // MID-GREY artwork so a white plate is unmistakable against it.
    const template = await sharp({ create: { width: 1070, height: 1470, channels: 3, background: '#555555' } }).jpeg().toBuffer();
    const geometry = deriveTemplateGeometry(1070, 1470);
    const out = await renderInvitationImage({
      templateBuffer: template,
      geometry,
      qrToken: 'IS26.PLATECOLOURTESTTOKEN0000000000000000000000',
      serial: text,
      profile: 'share',
    });
    return { out, geometry };
  }

  it('paints a real WHITE plate with GREEN ink on the rendered card (pixel proof), for short and long text', async () => {
    for (const text of ['VIP', 'IS26-00042', 'GRANDPARENTS TABLE ONE']) {
      const { out, geometry } = await renderCard(text);
      const meta = await sharp(out.buffer).metadata();
      const scale = (meta.width as number) / 1070;
      const fit = fitSerialFontSize(text, Math.round(geometry.serial.fontSize * scale), geometry.qr.size * scale * 1.6);
      const sx = Math.round(geometry.serial.x * scale);
      const sy = Math.round(geometry.serial.y * scale);
      const plate = serialPlateRect(sx, sy, fit.fontSize, fit.textW);

      const { data, info } = await sharp(out.buffer)
        .extract({ left: plate.x, top: plate.y, width: plate.w, height: plate.h })
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });

      let white = 0, green = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 235 && g > 235 && b > 235) white++;
        if (g > r + 35 && g > b + 25) green++;
      }
      const total = info.width * info.height;
      expect(white / total).toBeGreaterThan(0.45); // mostly white background
      expect(green).toBeGreaterThan(40); // actual green glyph ink present
      // and NO gold left in the plate
      let gold = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        if (data[i] > 170 && data[i + 1] > 130 && data[i + 1] < 185 && data[i + 2] < 120) gold++;
      }
      expect(gold).toBe(0);
    }
  });

  it('the four plate corners are visibly rounded (corner pixel shows the artwork, edge midpoint shows white)', async () => {
    const { out, geometry } = await renderCard('IS26-00042');
    const meta = await sharp(out.buffer).metadata();
    const scale = (meta.width as number) / 1070;
    const fit = fitSerialFontSize('IS26-00042', Math.round(geometry.serial.fontSize * scale), geometry.qr.size * scale * 1.6);
    const plate = serialPlateRect(Math.round(geometry.serial.x * scale), Math.round(geometry.serial.y * scale), fit.fontSize, fit.textW);
    const px = async (x: number, y: number) =>
      (await sharp(out.buffer).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer())[0];
    // extreme corner pixel is outside the rounded curve => still the dark artwork
    expect(await px(plate.x, plate.y)).toBeLessThan(150);
    expect(await px(plate.x + plate.w - 1, plate.y)).toBeLessThan(150);
    expect(await px(plate.x, plate.y + plate.h - 1)).toBeLessThan(150);
    expect(await px(plate.x + plate.w - 1, plate.y + plate.h - 1)).toBeLessThan(150);
    // midpoint of the top edge is inside the plate => white
    expect(await px(plate.x + Math.round(plate.w / 2), plate.y + 1)).toBeGreaterThan(220);
  });

  it('the ACCESS CODE label and QR box keep their gold (only the serial changed)', () => {
    const g = deriveTemplateGeometry(1070, 1470);
    expect(g.accessLabel.color).toBe('#C5A059');
    expect(g.qrBox.color).toBe('#C5A059');
  });
});
