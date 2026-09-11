import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { renderInvitationImage } from '@/lib/invitation/render';
import { deriveTemplateGeometry } from '@/lib/invitation/geometry';

async function decode(buffer: Buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}

describe('QR artwork decode pipeline', () => {
  it('decodes a generic QR using the worker decoder algorithm', async () => {
    expect(await decode(await QRCode.toBuffer('generic-scanner-check', { width: 400, margin: 4 })))
      .toBe('generic-scanner-check');
  });

  for (const background of ['#ffffff', '#16130b']) {
    it(`decodes a real rendered invitation on ${background} artwork after phone-size scaling`, async () => {
      const token = 'IS26.' + 'Abcdef0123456789_-'.repeat(3).slice(0, 43);
      const templateBuffer = await sharp({ create: { width: 1070, height: 1470, channels: 3, background } }).png().toBuffer();
      const { buffer } = await renderInvitationImage({
        templateBuffer, geometry: deriveTemplateGeometry(1070, 1470),
        qrToken: token, serial: 'TEST00001', profile: 'share',
      });
      const phoneImage = await sharp(buffer).resize({ height: 720 }).jpeg({ quality: 80 }).toBuffer();
      expect(await decode(buffer)).toBe(token);
      expect(await decode(phoneImage)).toBe(token);
    });
  }

  it('the gold QR box, drawn automatically for every template, never obstructs decoding — it sits entirely outside the QR footprint', async () => {
    const token = 'IS26.' + 'Abcdef0123456789_-'.repeat(3).slice(0, 43);
    const templateBuffer = await sharp({ create: { width: 1070, height: 1470, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const geometry = deriveTemplateGeometry(1070, 1470);
    const { buffer } = await renderInvitationImage({
      templateBuffer, geometry, qrToken: token, serial: 'TEST00002', profile: 'share',
    });
    // Still decodes cleanly, same as the plain 'template'-style path above.
    expect(await decode(buffer)).toBe(token);
    const phoneImage = await sharp(buffer).resize({ height: 720 }).jpeg({ quality: 80 }).toBuffer();
    expect(await decode(phoneImage)).toBe(token);

    // And the gold ring is actually there, just outside the QR's own box —
    // sample a pixel in the padding gap, just beyond the QR's right edge,
    // where the stroke is expected to sit.
    const scale = 3000 / 1470;
    const qrX = Math.round(geometry.qr.x * scale);
    const qrY = Math.round(geometry.qr.y * scale);
    const qrSize = Math.round(geometry.qr.size * scale);
    const pad = Math.round(qrSize * geometry.qrBox.paddingRatio);
    const stroke = Math.max(1, Math.round(qrSize * geometry.qrBox.strokeWidthRatio));
    // Same box math as render.ts: the right-hand vertical stroke of the
    // rect border sits at (qrX - pad) + (boxSize - stroke/2), which
    // simplifies to qrX + qrSize + pad - stroke/2.
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const sampleX = Math.round(qrX + qrSize + pad - stroke / 2);
    const sampleY = qrY + Math.round(qrSize / 2);
    const idx = (sampleY * info.width + sampleX) * info.channels;
    const [r, g, b] = [data[idx], data[idx + 1], data[idx + 2]];
    // #C5A059 — a warm gold, i.e. red/green channels clearly higher than blue.
    expect(r).toBeGreaterThan(150);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeLessThan(r);
  });
});
