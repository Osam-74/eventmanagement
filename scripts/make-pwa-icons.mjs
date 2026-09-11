/**
 * Generates all PWA icon variants for "Event Access" from the single brand
 * mark at public/brand/mark.png (the real logo — dark-navy circular badge,
 * blue/teal "EA" arrow mark, transparent background; supplied by the owner
 * 2026-09-11, replacing the earlier placeholder "EA" text monogram this
 * script used to draw):
 *  - public/icons/icon-192x192.png        (any purpose — kept transparent)
 *  - public/icons/icon-512x512.png        (any purpose — kept transparent)
 *  - public/icons/maskable-192x192.png    (maskable — flattened onto MASKABLE_BG)
 *  - public/icons/maskable-512x512.png    (maskable — flattened onto MASKABLE_BG)
 *  - public/icons/apple-touch-icon.png    (180x180 — flattened onto MASKABLE_BG;
 *                                           iOS renders transparent pixels as
 *                                           black, so this one can never be
 *                                           left transparent like the "any"
 *                                           icons above)
 *
 * The mark's own visible content (including its soft glow) already sits
 * within ~79% of its canvas — inside the maskable spec's 80% safe-zone
 * circle — so it's composited at full size with no extra shrinking; only
 * the maskable/apple variants get an opaque backing fill so OS mask shapes
 * never show as black or checkerboard at the corners.
 *
 * Deterministic, no external assets beyond the checked-in source PNG.
 * Run: node scripts/make-pwa-icons.mjs
 */
import sharp from 'sharp';

const SOURCE = 'public/brand/mark.png';
// Matches manifest.webmanifest's background_color/theme_color and the
// apple-touch-icon convention of a plain light backing behind the mark.
const MASKABLE_BG = '#ffffff';

async function anyIcon(size, out) {
  await sharp(SOURCE).resize(size, size, { fit: 'contain' }).png().toFile(out);
}

async function maskableIcon(size, out) {
  const mark = await sharp(SOURCE).resize(size, size, { fit: 'contain' }).png().toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: MASKABLE_BG },
  })
    .composite([{ input: mark, top: 0, left: 0 }])
    .png()
    .toFile(out);
}

const jobs = [
  ['src/app/icon.png', 48, anyIcon], // Next.js file-convention favicon — the tab icon / "opening the app" icon
  ['public/icons/icon-192x192.png', 192, anyIcon],
  ['public/icons/icon-512x512.png', 512, anyIcon],
  ['public/icons/maskable-192x192.png', 192, maskableIcon],
  ['public/icons/maskable-512x512.png', 512, maskableIcon],
  ['public/icons/apple-touch-icon.png', 180, maskableIcon],
];

for (const [out, size, fn] of jobs) {
  await fn(size, out);
  console.log('wrote', out);
}
