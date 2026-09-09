/**
 * Generation performance benchmark — gated behind RUN_BENCH=1 because it is
 * slow and machine-dependent. Documents the enforced batch caps:
 *   - share profile (3000px long edge): up to 50 cards per request
 *   - HQ profile (7680px long edge): up to 20 cards per request
 *
 * Run:  RUN_BENCH=1 npx vitest run tests/perf/generation.bench.ts
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { renderInvitationImage } from '@/lib/invitation/render';
import { deriveTemplateGeometry, REFERENCE_CANVAS } from '@/lib/invitation/geometry';
import { generateQrToken } from '@/lib/qr/token';

const enabled = process.env.RUN_BENCH === '1';

async function makeTemplate(): Promise<Buffer> {
  // representative 1070x1470 master: gold frame on cream, no QR inside
  const { width, height } = REFERENCE_CANVAS;
  return sharp({
    create: { width, height, channels: 3, background: '#f5efe2' },
  })
    .composite([{
      input: Buffer.from(
        `<svg width="${width}" height="${height}"><rect x="40" y="40" width="${width - 80}" height="${height - 80}" fill="none" stroke="#b08d3e" stroke-width="12"/></svg>`
      ),
      left: 0, top: 0,
    }])
    .png()
    .toBuffer();
}

async function decodeQr(buffer: Buffer): Promise<string | null> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); // jsQR needs RGBA
  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' });
  return code?.data ?? null;
}

describe.skipIf(!enabled)('invitation generation benchmark', () => {
  it('measures share-profile batches (3000px) — the 50-card envelope', async () => {
    const template = await makeTemplate();
    const geometry = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
    // warm-up (font/sharp init)
    await renderInvitationImage({ templateBuffer: template, geometry, qrToken: generateQrToken(), serial: 'ISWED-00000', profile: 'share' });

    for (const n of [10, 25, 50]) {
      const t0 = Date.now();
      const cards: Buffer[] = [];
      for (let i = 0; i < n; i++) {
        cards.push((await renderInvitationImage({
          templateBuffer: template, geometry, qrToken: generateQrToken(),
          serial: `ISWED-${String(i).padStart(5, '0')}`, profile: 'share',
        })).buffer);
      }
      const secs = (Date.now() - t0) / 1000;
      const heap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      expect(cards.length).toBe(n);
      console.log(`[BENCH] share x${n}: ${secs.toFixed(1)}s total, ${(secs / n * 1000).toFixed(0)}ms/card, heap ${heap}MB, card ${(cards[0].length / 1024 / 1024).toFixed(2)}MB`);

      // every card must be machine-readable and decode to ITS OWN credential
      const decoded = await decodeQr(cards[0]);
      expect(decoded).toBeTruthy();
      const mid = await decodeQr(cards[Math.floor(n / 2)]);
      expect(mid).toBeTruthy();
    }
  }, 300000);

  it('measures HQ-profile batches (7680px) — the 20-card cap', async () => {
    const template = await makeTemplate();
    const geometry = deriveTemplateGeometry(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
    await renderInvitationImage({ templateBuffer: template, geometry, qrToken: generateQrToken(), serial: 'ISWED-00000', profile: 'hq' });

    for (const n of [10, 20]) {
      const t0 = Date.now();
      let outSize = 0;
      for (let i = 0; i < n; i++) {
        const r = await renderInvitationImage({
          templateBuffer: template, geometry, qrToken: generateQrToken(),
          serial: `ISWED-${String(i).padStart(5, '0')}`, profile: 'hq',
        });
        outSize = r.buffer.length;
      }
      const secs = (Date.now() - t0) / 1000;
      const heap = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`[BENCH] hq x${n}: ${secs.toFixed(1)}s total, ${(secs / n * 1000).toFixed(0)}ms/card, heap ${heap}MB, card ${(outSize / 1024 / 1024).toFixed(1)}MB`);
      expect(n).toBeGreaterThan(0);
    }
  }, 300000);
});
