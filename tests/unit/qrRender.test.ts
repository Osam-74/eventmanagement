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
});
