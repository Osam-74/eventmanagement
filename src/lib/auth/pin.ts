import { createHmac } from 'crypto';

/**
 * Usher PIN cryptography — two keyed derivations, one server-only pepper.
 *
 * 1. `pinLookupIndex(pin)` — deterministic, keyed digest of the PIN alone.
 *    Used as the document ID in the `pinRegistry` collection so the server
 *    can resolve a bare PIN to its usher WITHOUT storing plaintext PINs and
 *    WITHOUT knowing the usher's identity in advance. Uniqueness among
 *    active ushers is enforced atomically by Firestore document-ID creation
 *    (see usherAuth.ts). Without the pepper the index is computationally
 *    useless offline, and it is never compared in plaintext anywhere.
 *
 * 2. `pinVerifier(usherId, pin)` — per-account confirmation key, compared
 *    timing-safely AFTER lookup. Kept stable across versions so existing
 *    stored verifier values remain valid.
 *
 * PINs are low entropy, so this is defense-in-depth — the real protection
 * is server-side rate limiting, temporary lockout, and the atomic registry.
 */
function pepper(): string {
  const p = process.env.USHER_PIN_PEPPER;
  if (!p) throw new Error('USHER_PIN_PEPPER is not configured.');
  return p;
}

export function pinVerifier(usherId: string, pin: string): string {
  return createHmac('sha256', pepper()).update(`${usherId}:${pin}`).digest('hex');
}

export function pinLookupIndex(pin: string): string {
  return createHmac('sha256', pepper()).update(`pin-index:${pin}`).digest('hex');
}

export function generateRandomPin(): string {
  // 6-digit, always leading digit 1-9
  return String(100000 + Math.floor(Math.random() * 900000));
}
