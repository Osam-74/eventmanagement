import sharp from 'sharp';
import QRCode from 'qrcode';
import { measureSerialWidth, serialToSvgPaths } from '@/lib/invitation/serialGlyphs';

export type TemplateGeometry = {
  canvasWidth: number;
  canvasHeight: number;
  qr: { x: number; y: number; size: number };
  serial?: {
    enabled: boolean;
    x: number;
    y: number;
    fontSize: number;
    color: string;
    plate?: boolean;
  };
  // Optional — omitted (or style 'template') reproduces the exact output
  // this function always produced: no extra overlay, the master artwork's
  // own hand-drawn frame is what the viewer sees around the QR. Only
  // style 'auto' draws anything here. See src/lib/invitation/geometry.ts.
  qrBox?: {
    style: 'template' | 'auto';
    color: string;
    strokeWidthRatio: number;
    paddingRatio: number;
    cornerRadiusRatio: number;
  };
};

export const SHARE_LONG_EDGE = 3000;
export const HQ_LONG_EDGE = 7680;

/**
 * Custom card tags (e.g. "GRANDPARENTS TABLE ONE", "VIP") can run far
 * longer than a fixed-length serial was ever tuned for. Shrinks fontSize
 * (down to half, floor) so the text never runs past `maxTextW` — kept as
 * its own pure function so the width math is unit-testable without
 * rendering a full image. No-ops (returns the inputs unchanged) whenever
 * the text already fits, so every existing serial's size is untouched.
 */
export function fitSerialFontSize(
  text: string,
  fontSize: number,
  maxTextW: number
): { fontSize: number; letterSpacing: number; textW: number } {
  let size = fontSize;
  let letterSpacing = Math.round(size * 0.08);
  let textW = measureSerialWidth(text, size, letterSpacing);
  if (textW > maxTextW) {
    const shrink = Math.max(maxTextW / textW, 0.5);
    size = Math.round(size * shrink);
    letterSpacing = Math.round(size * 0.08);
    textW = measureSerialWidth(text, size, letterSpacing);
  }
  return { fontSize: size, letterSpacing, textW };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/**
 * Renders one finished invitation:
 * 1. scale the approved template to the requested output size (uniform scale)
 * 2. composite the QR exactly inside the approved box (true square, white backing)
 * 3. overlay the traceable serial number
 */
export async function renderInvitationImage(opts: {
  templateBuffer: Buffer;
  geometry: TemplateGeometry;
  qrToken: string;
  serial: string;
  profile: 'share' | 'hq';
}): Promise<{ buffer: Buffer; width: number; height: number; contentType: string }> {
  const { templateBuffer, geometry, qrToken, serial, profile } = opts;

  const longEdge = profile === 'hq' ? HQ_LONG_EDGE : SHARE_LONG_EDGE;
  const scale = longEdge / Math.max(geometry.canvasWidth, geometry.canvasHeight);
  const width = Math.round(geometry.canvasWidth * scale);
  const height = Math.round(geometry.canvasHeight * scale);
  const qrSize = Math.round(geometry.qr.size * scale);
  const qrX = Math.round(geometry.qr.x * scale);
  const qrY = Math.round(geometry.qr.y * scale);

  const qrBuffer = await QRCode.toBuffer(qrToken, {
    errorCorrectionLevel: 'Q',
    // Four light modules on every side are part of the QR bitmap itself.
    // Keep the approved outer box unchanged; artwork/frame is not a quiet zone.
    margin: 4,
    width: qrSize,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });

  const overlays: sharp.OverlayOptions[] = [];

  // Auto-drawn QR box (owner request 2026-09-11): a gold-stroked frame
  // rendered ENTIRELY OUTSIDE the qrX/qrY/qrSize footprint — padding always
  // pushes it outward, never inward — so it can never touch, let alone
  // cover, a single QR module. Only style 'auto' draws this; every
  // template without it (i.e. all of them until an admin opts in) gets
  // this array empty, identical to before this feature existed.
  if (geometry.qrBox?.style === 'auto') {
    const pad = Math.round(qrSize * geometry.qrBox.paddingRatio);
    const stroke = Math.max(1, Math.round(qrSize * geometry.qrBox.strokeWidthRatio));
    const radius = Math.round(qrSize * geometry.qrBox.cornerRadiusRatio);
    const boxSize = qrSize + pad * 2;
    const half = stroke / 2;
    const color = escapeXml(geometry.qrBox.color);
    overlays.push({
      input: Buffer.from(
        `<svg width="${boxSize}" height="${boxSize}">` +
          `<rect x="${half}" y="${half}" width="${boxSize - stroke}" height="${boxSize - stroke}" ` +
          `rx="${radius}" fill="none" stroke="${color}" stroke-width="${stroke}"/>` +
          `</svg>`
      ),
      left: qrX - pad,
      top: qrY - pad,
    });
  }

  // clean white backing so QR modules always sit on white inside the frame
  overlays.push(
    {
      input: Buffer.from(
        `<svg width="${qrSize}" height="${qrSize}"><rect width="${qrSize}" height="${qrSize}" fill="#ffffff"/></svg>`
      ),
      left: qrX,
      top: qrY,
    },
    { input: qrBuffer, left: qrX, top: qrY }
  );

  if (geometry.serial?.enabled) {
    // The serial is drawn as VECTOR PATHS, not SVG <text>: sharp renders
    // <text> through fontconfig, and the Vercel serverless image ships no
    // usable fonts — the serial silently came out blank on production
    // cards. Paths render identically on every host. See serialGlyphs.ts.
    // Long custom tags never spill past a sane width relative to the QR box
    // instead of running into the card's frame artwork; every existing
    // serial is well under this bound so its size/position is untouched.
    const { fontSize, letterSpacing, textW } = fitSerialFontSize(
      serial,
      Math.round(geometry.serial.fontSize * scale),
      qrSize * 1.6
    );
    const sx = Math.round(geometry.serial.x * scale);
    const sy = Math.round(geometry.serial.y * scale);
    const color = escapeXml(geometry.serial.color);
    let content = serialToSvgPaths(serial, sx, sy, fontSize, letterSpacing, color);
    if (geometry.serial.plate) {
      // White rounded plate guarantees the serial is legible on ANY
      // artwork background (gold frame, dark motif, photo).
      const plateW = Math.round(textW + fontSize * 1.6);
      const plateH = Math.round(fontSize * 1.7);
      const plateX = Math.round(sx - plateW / 2);
      const plateY = Math.round(sy - fontSize * 1.18);
      content =
        `<rect x="${plateX}" y="${plateY}" width="${plateW}" height="${plateH}" rx="${Math.round(plateH / 4)}" fill="#ffffff"/>` +
        content;
    }
    overlays.push({
      input: Buffer.from(`<svg width="${width}" height="${height}">${content}</svg>`),
      left: 0,
      top: 0,
    });
  }

  const buffer = await sharp(templateBuffer)
    .resize(width, height, { fit: 'fill' })
    .composite(overlays)
    .jpeg({ quality: profile === 'hq' ? 95 : 92, mozjpeg: true })
    .toBuffer();

  return { buffer, width, height, contentType: 'image/jpeg' };
}
