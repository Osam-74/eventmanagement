import { afterEach, describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { guestMomentsUrl, siteBaseUrl, DEFAULT_SITE_URL } from '@/lib/moments/guestLink';

afterEach(() => { delete process.env.NEXT_PUBLIC_SITE_URL; });

describe('guest moments link + QR', () => {
  it('defaults to the canonical custom domain, never the old vercel.app one', () => {
    expect(DEFAULT_SITE_URL).toBe('https://eventmgt.deodevs.com');
    expect(guestMomentsUrl('is-wedding-2026')).toBe('https://eventmgt.deodevs.com/moments/is-wedding-2026');
    expect(guestMomentsUrl('x')).not.toContain('vercel.app');
  });
  it('NEXT_PUBLIC_SITE_URL overrides it and trailing slashes are trimmed', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://events.example.org//';
    expect(siteBaseUrl()).toBe('https://events.example.org');
    expect(guestMomentsUrl('a')).toBe('https://events.example.org/moments/a');
  });
  it('encodes an unusual slug safely', () => {
    expect(guestMomentsUrl('a b/c')).toBe('https://eventmgt.deodevs.com/moments/a%20b%2Fc');
  });
  it('the QR (same options as the panel) decodes back to exactly the link, also after phone-size downscale', async () => {
    const link = guestMomentsUrl('is-wedding-2026');
    const png = Buffer.from((await QRCode.toDataURL(link, { width: 1024, margin: 4, errorCorrectionLevel: 'H' })).split(',')[1], 'base64');
    const dec = async (b: Buffer) => {
      const { data, info } = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
    };
    expect(await dec(png)).toBe(link);
    expect(await dec(await sharp(png).resize(180).jpeg({ quality: 70 }).toBuffer())).toBe(link);
  });
});
