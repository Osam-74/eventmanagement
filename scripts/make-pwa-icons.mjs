/**
 * Generates PWA icons for "Event Access" from an SVG monogram:
 *  - public/icons/icon-192x192.png        (any purpose)
 *  - public/icons/icon-512x512.png        (any purpose)
 *  - public/icons/maskable-192x192.png    (maskable, safe-zone padded)
 *  - public/icons/maskable-512x512.png    (maskable, safe-zone padded)
 *  - public/icons/apple-touch-icon.png    (180x180)
 * Deterministic, no external assets. Run: node scripts/make-pwa-icons.mjs
 */
import sharp from 'sharp';

const BG = '#1c1917';   // stone-900 — matches the app header
const FG = '#e7e5e4';   // stone-200 — clean, neutral product identity

const monogram = (fullBleed, size) => {
  // For maskable icons the entire canvas is background (safe zone = center 80%).
  const font = Math.round(size * 0.34);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" rx="${fullBleed ? 0 : size * 0.14}" fill="${BG}"/>
      <rect width="${size}" height="${size}" fill="${BG}" opacity="0"/>
      <text x="50%" y="55%" font-family="Helvetica, Arial, sans-serif"
            font-size="${font}" font-style="normal" font-weight="700"
            letter-spacing="${size * 0.02}" fill="${FG}" text-anchor="middle" dominant-baseline="middle">EA</text>
    </svg>`
  );
};

const jobs = [
  ['public/icons/icon-192x192.png', 192, false],
  ['public/icons/icon-512x512.png', 512, false],
  ['public/icons/maskable-192x192.png', 192, true],
  ['public/icons/maskable-512x512.png', 512, true],
  ['public/icons/apple-touch-icon.png', 180, true],
];

for (const [out, size, fullBleed] of jobs) {
  await sharp(monogram(fullBleed, size)).png().toFile(out);
  console.log('wrote', out);
}
