import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { generateBatchSchema } from '@/lib/validation/schemas';
import { isDrawableSerialText, measureSerialWidth, serialToSvgPaths } from '@/lib/invitation/serialGlyphs';
import { renderInvitationImage, fitSerialFontSize, serialPlateRect } from '@/lib/invitation/render';
import { deriveTemplateGeometry } from '@/lib/invitation/geometry';

const parse = (tag: string) =>
  generateBatchSchema.safeParse({ eventId: 'event1234', quantity: 1, profile: 'share', cardType: 'special', tag });

/**
 * Owner request 2026-09-29: tags must accept an apostrophe (and similar
 * symbols). The validator is derived from the glyph table, so the invariant
 * under test is: ACCEPTED  <=>  CAN BE DRAWN.
 */
describe('tag characters', () => {
  it('accepts the apostrophe in real-world tags, straight and curly (phones type the curly one)', () => {
    for (const tag of ["BRIDE'S FAMILY", "Groom's Side", 'BRIDE’S FAMILY', "ST. MARY'S", "AUNTY'S TABLE 2"]) {
      expect(parse(tag).success, tag).toBe(true);
    }
  });

  it('accepts common symbols people put in table / group names', () => {
    for (const tag of ['A & B', 'TABLE #4', 'VIP (GOLD)', 'ROW 1/2', 'HOST, FAMILY', 'NO. 5: FRONT', 'WELCOME!', 'A+B', 'MR_MRS', '@HOME']) {
      expect(parse(tag).success, tag).toBe(true);
    }
  });

  it('still accepts everything that was valid before', () => {
    for (const tag of ['VIP', 'FAMILY', 'GRANDPARENTS TABLE ONE', 'A-B', 'X.Y', 'usher 2']) {
      expect(parse(tag).success, tag).toBe(true);
    }
  });

  it('still rejects characters the card cannot draw, with a clear message', () => {
    for (const tag of ['<script>', 'VIP;', 'A"B', 'TAB\tX', 'ÀÉÎ', '😀', 'A|B', 'X\\Y', 'A=B', '{x}']) {
      const r = parse(tag);
      expect(r.success, tag).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toContain('Tag can only contain');
    }
  });

  it('keeps the 24-character cap and the "Special needs a tag" rule', () => {
    expect(parse("A'".repeat(13)).success).toBe(false); // 26 chars
    expect(parse("A'".repeat(12)).success).toBe(true); // 24 chars
    expect(parse('   ').success).toBe(false);
  });

  it('INVARIANT: every accepted tag is fully drawable (no silently-blank characters)', () => {
    for (const tag of ["BRIDE'S", 'A & B', 'TABLE #4', 'LOWER case', '(x)']) {
      const r = parse(tag);
      expect(r.success).toBe(true);
      expect(isDrawableSerialText(tag.toUpperCase())).toBe(true);
    }
  });

  it('every new symbol produces real ink and a real width (not the 0.6em fallback)', () => {
    for (const ch of ["'", '’', '‘', '&', ',', '/', '(', ')', '!', '#', '@', '+', ':', '_']) {
      expect((serialToSvgPaths(ch, 100, 100, 40, 3, '#000').match(/<path /g) ?? []).length, ch).toBe(1);
      // an undrawable char falls back to exactly 0.6em; a real glyph has its own advance
      expect(measureSerialWidth(ch, 2048, 0)).not.toBe(2048 * 0.6);
    }
  });

  it('an apostrophe tag paints on the rendered card, inside the white plate (pixel proof)', async () => {
    const template = await sharp({ create: { width: 1070, height: 1470, channels: 3, background: '#555555' } }).jpeg().toBuffer();
    const geometry = deriveTemplateGeometry(1070, 1470);
    const text = "BRIDE'S FAMILY";
    const { buffer } = await renderInvitationImage({ templateBuffer: template, geometry, qrToken: 'IS26.APOSTROPHETESTTOKEN00000000000000000000', serial: text, profile: 'share' });
    const meta = await sharp(buffer).metadata();
    const scale = (meta.width as number) / 1070;
    const fit = fitSerialFontSize(text, Math.round(geometry.serial.fontSize * scale), geometry.qr.size * scale * 1.6);
    const plate = serialPlateRect(Math.round(geometry.serial.x * scale), Math.round(geometry.serial.y * scale), fit.fontSize, fit.textW);
    const { data, info } = await sharp(buffer).extract({ left: plate.x, top: plate.y, width: plate.w, height: plate.h }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i + 1] > data[i] + 35 && data[i + 1] > data[i + 2] + 25) green++;
    expect(green).toBeGreaterThan(60);

    // and the apostrophe itself is drawn: same text WITHOUT it has strictly less ink
    const plain = "BRIDES FAMILY";
    const r2 = await renderInvitationImage({ templateBuffer: template, geometry, qrToken: 'IS26.APOSTROPHETESTTOKEN00000000000000000000', serial: plain, profile: 'share' });
    const fit2 = fitSerialFontSize(plain, Math.round(geometry.serial.fontSize * scale), geometry.qr.size * scale * 1.6);
    const p2 = serialPlateRect(Math.round(geometry.serial.x * scale), Math.round(geometry.serial.y * scale), fit2.fontSize, fit2.textW);
    const d2 = await sharp(r2.buffer).extract({ left: p2.x, top: p2.y, width: p2.w, height: p2.h }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let green2 = 0;
    for (let i = 0; i < d2.data.length; i += d2.info.channels) if (d2.data[i + 1] > d2.data[i] + 35 && d2.data[i + 1] > d2.data[i + 2] + 25) green2++;
    expect(green).toBeGreaterThan(green2);
  });

  it('a max-length tag of the widest symbols still stays on the card', () => {
    const W = 1070;
    const g = deriveTemplateGeometry(W, 1470);
    for (const worst of ['@'.repeat(24), '&'.repeat(24), 'W'.repeat(24), '#'.repeat(24)]) {
      const fit = fitSerialFontSize(worst, g.serial.fontSize, g.qr.size * 1.6);
      const plate = serialPlateRect(g.serial.x, g.serial.y, fit.fontSize, fit.textW);
      expect(plate.x).toBeGreaterThanOrEqual(0);
      expect(plate.x + plate.w).toBeLessThanOrEqual(W);
    }
  });
});
