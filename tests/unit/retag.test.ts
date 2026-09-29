import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { renderInvitationImage } from '@/lib/invitation/render';
import { deriveTemplateGeometry } from '@/lib/invitation/geometry';
import { retagInvitationImage, plateFor, unionRegion, overlaps } from '@/lib/invitation/retag';

const W = 1070, H = 1470;
const TOKEN = 'IS26.' + 'Abcdef0123456789_-'.repeat(3).slice(0, 43);
const geometry = deriveTemplateGeometry(W, H);
const scale = 3000 / Math.max(W, H);

/** A deliberately BUSY template (diagonal stripes + gradient) so remnants/seams would be visible. */
async function busyTemplate() {
  const stripes = Array.from({ length: 60 }, (_, i) => `<rect x="${i * 40 - 600}" y="0" width="14" height="${H * 2}" fill="#c5a059" opacity="0.55" transform="rotate(20 ${W / 2} ${H / 2})"/>`).join('');
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16302a"/><stop offset="1" stop-color="#7a4a1e"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/>${stripes}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function raw(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}
async function decode(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}
const card = async (template: Buffer, text: string) =>
  (await renderInvitationImage({ templateBuffer: template, geometry, qrToken: TOKEN, serial: text, profile: 'share' })).buffer;

/** Mean absolute per-channel difference between two rasters over a rectangle. */
function meanDiff(a: Awaited<ReturnType<typeof raw>>, b: Awaited<ReturnType<typeof raw>>, r: { left: number; top: number; width: number; height: number }) {
  let sum = 0, n = 0;
  for (let y = r.top; y < r.top + r.height; y++) for (let x = r.left; x < r.left + r.width; x++) {
    const i = (y * a.w + x) * a.c;
    for (let k = 0; k < 3; k++) { sum += Math.abs(a.data[i + k] - b.data[i + k]); n++; }
  }
  return sum / n;
}

describe('retag: change the printed tag/serial without touching the QR', () => {
  const cases: [string, string, string][] = [
    ['shorter tag replaces a longer one', 'GRANDPARENTS TABLE ONE', 'VIP'],
    ['longer tag replaces a shorter one', 'VIP', 'GRANDPARENTS TABLE ONE'],
    ['tag replaces a serial', 'IS26-000123', "BRIDE'S FAMILY"],
    ['serial restored after a tag', 'FAMILY', 'IS26-000123'],
  ];

  for (const [name, oldText, newText] of cases) {
    it(name, async () => {
      const template = await busyTemplate();
      const before = await card(template, oldText);
      const { buffer: after, region } = await retagInvitationImage({
        existingCard: before, templateBuffer: template, geometry, oldText, newText, profile: 'share',
      });

      // 1. SAME QR: still decodes to the identical token, also after phone-size downscale
      expect(await decode(after)).toBe(TOKEN);
      expect(await decode(await sharp(after).resize({ height: 720 }).jpeg({ quality: 80 }).toBuffer())).toBe(TOKEN);

      // 2. Same dimensions
      const b = await raw(before), a = await raw(after);
      expect([a.w, a.h]).toEqual([b.w, b.h]);

      // 3. The QR and its gold frame are visually unchanged (only JPEG re-compression noise)
      const qrSize = Math.round(geometry.qr.size * scale);
      const qrX = Math.round(geometry.qr.x * scale), qrY = Math.round(geometry.qr.y * scale);
      const pad = Math.round(qrSize * geometry.qrBox.paddingRatio) + 6;
      const qrRect = { left: qrX - pad, top: qrY - pad, width: qrSize + pad * 2, height: qrSize + pad * 2 };
      expect(meanDiff(b, a, qrRect)).toBeLessThan(1.5);

      // 4. Everything outside the plate region (whole card minus region) is unchanged too
      const above = { left: 0, top: 0, width: W * scale | 0, height: region.top };
      expect(meanDiff(b, a, above)).toBeLessThan(1.5);

      // 5. The plate region now looks like a card FRESHLY rendered with the new text
      const fresh = await raw(await card(template, newText));
      expect(meanDiff(fresh, a, region)).toBeLessThan(3);
    });
  }

  it('no sliver of the old plate survives when the new text is shorter (compared with a fresh render)', async () => {
    const template = await busyTemplate();
    const old = 'GRANDPARENTS TABLE ONE', neu = 'VIP';
    const before = await card(template, old);
    const { buffer: after } = await retagInvitationImage({ existingCard: before, templateBuffer: template, geometry, oldText: old, newText: neu, profile: 'share' });
    const oldRect = plateFor(old, geometry, 'share').rect;
    const a = await raw(after), fresh = await raw(await card(template, neu));
    // the band that only the OLD plate covered must equal the clean artwork of a fresh render
    const band = { left: oldRect.x, top: oldRect.y, width: oldRect.w, height: oldRect.h };
    expect(meanDiff(fresh, a, band)).toBeLessThan(3);
  });

  it('the patch region never overlaps the QR or its frame, for any tag length, on real geometry', () => {
    const qrSize = Math.round(geometry.qr.size * scale);
    const qrX = Math.round(geometry.qr.x * scale), qrY = Math.round(geometry.qr.y * scale);
    const pad = Math.round(qrSize * geometry.qrBox.paddingRatio) + Math.max(1, Math.round(qrSize * geometry.qrBox.strokeWidthRatio));
    const keepOut = { x: qrX - pad, y: qrY - pad, w: qrSize + pad * 2, h: qrSize + pad * 2 };
    for (const t of ['A', 'VIP', 'IS26-000123', 'GRANDPARENTS TABLE ONE', 'X'.repeat(24), 'W'.repeat(24)]) {
      for (const u of ['A', 'W'.repeat(24), 'GRANDPARENTS TABLE ONE']) {
        const region = unionRegion(plateFor(t, geometry, 'share').rect, plateFor(u, geometry, 'share').rect, { width: 3000, height: 3000 }, 6);
        expect(overlaps(region, keepOut), `${t} -> ${u}`).toBe(false);
      }
    }
  });

  it('refuses a card whose size does not match the template (would corrupt it)', async () => {
    const template = await busyTemplate();
    const wrong = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    await expect(retagInvitationImage({ existingCard: wrong, templateBuffer: template, geometry, oldText: 'A', newText: 'B', profile: 'share' })).rejects.toThrow(/refusing/);
  });

  it('works for the HQ output profile too', async () => {
    const template = await busyTemplate();
    const before = (await renderInvitationImage({ templateBuffer: template, geometry, qrToken: TOKEN, serial: 'VIP', profile: 'hq' })).buffer;
    const { buffer } = await retagInvitationImage({ existingCard: before, templateBuffer: template, geometry, oldText: 'VIP', newText: 'FAMILY', profile: 'hq' });
    expect(await decode(buffer)).toBe(TOKEN);
  }, 60000);
});

describe('region math', () => {
  it('unionRegion covers both plates plus margin and clamps to the canvas', () => {
    const r = unionRegion({ x: 10, y: 10, w: 100, h: 20 }, { x: 60, y: 5, w: 200, h: 30 }, { width: 250, height: 100 }, 6);
    expect(r).toEqual({ left: 4, top: 0, width: 246, height: 41 });
  });
});
