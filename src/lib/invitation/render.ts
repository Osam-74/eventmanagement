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
};

export const SHARE_LONG_EDGE = 3000;
export const HQ_LONG_EDGE = 7680;

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
    margin: 0,
    width: qrSize,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });

  const overlays: sharp.OverlayOptions[] = [
    // clean white backing so QR modules always sit on white inside the frame
    {
      input: Buffer.from(
        `<svg width="${qrSize}" height="${qrSize}"><rect width="${qrSize}" height="${qrSize}" fill="#ffffff"/></svg>`
      ),
      left: qrX,
      top: qrY,
    },
    { input: qrBuffer, left: qrX, top: qrY },
  ];

  if (geometry.serial?.enabled) {
    // The serial is drawn as VECTOR PATHS, not SVG <text>: sharp renders
    // <text> through fontconfig, and the Vercel serverless image ships no
    // usable fonts — the serial silently came out blank on production
    // cards. Paths render identically on every host. See serialGlyphs.ts.
    const fontSize = Math.round(geometry.serial.fontSize * scale);
    const sx = Math.round(geometry.serial.x * scale);
    const sy = Math.round(geometry.serial.y * scale);
    const letterSpacing = Math.round(fontSize * 0.08);
    const textW = measureSerialWidth(serial, fontSize, letterSpacing);
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
