import sharp from 'sharp';
import QRCode from 'qrcode';

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
    const fontSize = Math.round(geometry.serial.fontSize * scale);
    const sx = Math.round(geometry.serial.x * scale);
    const sy = Math.round(geometry.serial.y * scale);
    let content = `<text x="${sx}" y="${sy}" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600" fill="${escapeXml(
      geometry.serial.color
    )}" text-anchor="middle" letter-spacing="${Math.round(fontSize * 0.08)}">${escapeXml(serial)}</text>`;
    if (geometry.serial.plate) {
      // White rounded plate guarantees the serial is legible on ANY
      // artwork background (gold frame, dark motif, photo).
      const plateW = Math.round(serial.length * fontSize * 0.64 + fontSize * 1.6);
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
