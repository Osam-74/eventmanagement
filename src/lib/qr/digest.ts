import { createHmac, timingSafeEqual } from 'crypto';

export function digestToken(token: string): string {
  const key = process.env.QR_TOKEN_HMAC_KEY;
  if (!key) {
    throw new Error('QR_TOKEN_HMAC_KEY is not configured.');
  }
  return createHmac('sha256', key).update(token, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
