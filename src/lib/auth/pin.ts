import { createHmac } from 'crypto';

/**
 * Usher PIN verifier: HMAC-SHA256(pepper, usherId:pin).
 * PINs are low entropy, so this is defense-in-depth — the real protection
 * is server-side rate limiting and temporary lockout.
 */
function pepper(): string {
  const p = process.env.USHER_PIN_PEPPER;
  if (!p) throw new Error('USHER_PIN_PEPPER is not configured.');
  return p;
}

export function pinVerifier(usherId: string, pin: string): string {
  return createHmac('sha256', pepper()).update(`${usherId}:${pin}`).digest('hex');
}

export function generateRandomPin(): string {
  // 6-digit, always leading digit 1-9
  return String(100000 + Math.floor(Math.random() * 900000));
}
