import sharp from 'sharp';
import { measureSerialWidth, serialToSvgPaths } from '@/lib/invitation/serialGlyphs';
import { fitSerialFontSize, serialPlateRect, SHARE_LONG_EDGE, HQ_LONG_EDGE, type TemplateGeometry } from '@/lib/invitation/render';

/**
 * Change the printed serial/tag of an EXISTING card WITHOUT touching its QR.
 *
 * Why this exists: the raw QR token is never stored (only its HMAC digest,
 * which is the invitation's document id), so a card can never be re-rendered
 * with the same QR. "Regenerate" therefore issues a new QR and revokes the
 * old card — wrong for a simple text correction, because a guest who already
 * has the card would be turned away.
 *
 * Instead this repaints ONLY the plate area of the finished JPEG:
 *   1. re-render the SAME template artwork at the card's output size,
 *   2. draw the NEW plate + text on that artwork (no QR anywhere),
 *   3. cut out the region covered by the OLD plate or the NEW plate (the
 *      union, so no sliver of the old plate/text can survive when the new
 *      text is shorter), and
 *   4. paste that cut-out over the existing card.
 * Every pixel outside that region — including the whole QR, its gold frame
 * and the "ACCESS CODE" label — is carried over unchanged from the existing
 * card, so the QR stays scannable and identical. Only that plate rectangle is
 * re-encoded (JPEG has no partial save), so the QR's pixels are re-compressed
 * at the same quality; `qrRegionUnchanged` in the tests pins that this stays
 * decodable and visually identical.
 */

export type PlateRegion = { left: number; top: number; width: number; height: number };

/** Size/position of the plate for `text` at the card's output scale. */
export function plateFor(
  text: string,
  geometry: TemplateGeometry,
  profile: 'share' | 'hq'
): { rect: ReturnType<typeof serialPlateRect>; fontSize: number; letterSpacing: number; textW: number; sx: number; sy: number; scale: number } {
  if (!geometry.serial?.enabled) throw new Error('This template does not print a serial/tag.');
  const longEdge = profile === 'hq' ? HQ_LONG_EDGE : SHARE_LONG_EDGE;
  const scale = longEdge / Math.max(geometry.canvasWidth, geometry.canvasHeight);
  const qrSize = Math.round(geometry.qr.size * scale);
  const fit = fitSerialFontSize(text, Math.round(geometry.serial.fontSize * scale), qrSize * 1.6);
  const sx = Math.round(geometry.serial.x * scale);
  const sy = Math.round(geometry.serial.y * scale);
  return { rect: serialPlateRect(sx, sy, fit.fontSize, fit.textW), ...fit, sx, sy, scale };
}

/** Smallest rectangle containing both plates, with a small safety margin, clamped to the canvas. */
export function unionRegion(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  canvas: { width: number; height: number },
  margin: number
): PlateRegion {
  const left = Math.max(0, Math.min(a.x, b.x) - margin);
  const top = Math.max(0, Math.min(a.y, b.y) - margin);
  const right = Math.min(canvas.width, Math.max(a.x + a.w, b.x + b.w) + margin);
  const bottom = Math.min(canvas.height, Math.max(a.y + a.h, b.y + b.h) + margin);
  return { left, top, width: right - left, height: bottom - top };
}

/** True when two rectangles share any area. Used to guarantee the patch never reaches the QR. */
export function overlaps(a: PlateRegion, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.left < b.x + b.w && a.left + a.width > b.x && a.top < b.y + b.h && a.top + a.height > b.y;
}

export async function retagInvitationImage(opts: {
  existingCard: Buffer;
  templateBuffer: Buffer;
  geometry: TemplateGeometry;
  oldText: string;
  newText: string;
  profile: 'share' | 'hq';
}): Promise<{ buffer: Buffer; region: PlateRegion }> {
  const { existingCard, templateBuffer, geometry, oldText, newText, profile } = opts;
  const oldPlate = plateFor(oldText, geometry, profile);
  const newPlate = plateFor(newText, geometry, profile);
  const { scale } = newPlate;
  const width = Math.round(geometry.canvasWidth * scale);
  const height = Math.round(geometry.canvasHeight * scale);

  const meta = await sharp(existingCard).metadata();
  if (meta.width !== width || meta.height !== height) {
    throw new Error(`Card image is ${meta.width}x${meta.height}, expected ${width}x${height}; refusing to patch a card of a different size.`);
  }

  const qrSize = Math.round(geometry.qr.size * scale);
  const qrX = Math.round(geometry.qr.x * scale);
  const qrY = Math.round(geometry.qr.y * scale);
  // The QR's own footprint plus its gold frame's outward padding.
  const framePad = Math.round(qrSize * (geometry.qrBox?.paddingRatio ?? 0)) + Math.max(1, Math.round(qrSize * (geometry.qrBox?.strokeWidthRatio ?? 0)));
  const qrKeepOut = { x: qrX - framePad, y: qrY - framePad, w: qrSize + framePad * 2, h: qrSize + framePad * 2 };

  const region = unionRegion(oldPlate.rect, newPlate.rect, { width, height }, 6);
  if (overlaps(region, qrKeepOut)) {
    // Never risk the QR: if the plate area would touch it, stop instead of painting.
    throw new Error('The tag area overlaps the QR code on this template; refusing to edit it in place.');
  }

  // Clean artwork at card size, with the NEW plate + text drawn on it (no QR, no label needed:
  // the label sits above the plate and outside the region, so it is carried over from the card).
  const color = geometry.serial!.color.replace(/[<>&"']/g, '');
  let content = serialToSvgPaths(newText, newPlate.sx, newPlate.sy, newPlate.fontSize, newPlate.letterSpacing, color);
  if (geometry.serial!.plate) {
    const { x, y, w, h, rx } = newPlate.rect;
    content = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ry="${rx}" fill="#ffffff"/>` + content;
  }
  // Composite at full size FIRST and crop in a second step: within one sharp
  // pipeline .extract() runs before .composite(), which would crop the base
  // smaller than the full-canvas overlay and fail.
  const fullArt = await sharp(templateBuffer)
    .resize(width, height, { fit: 'fill' })
    .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}">${content}</svg>`), left: 0, top: 0 }])
    .png()
    .toBuffer();
  const patch = await sharp(fullArt).extract(region).png().toBuffer();

  const buffer = await sharp(existingCard)
    .composite([{ input: patch, left: region.left, top: region.top }])
    .jpeg({ quality: profile === 'hq' ? 95 : 92, mozjpeg: true })
    .toBuffer();

  return { buffer, region };
}

export { measureSerialWidth };
