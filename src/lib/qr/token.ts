import { randomBytes } from 'crypto';

/**
 * Credential format: IS26.<32 random bytes, url-safe base64, no padding>.
 * Contains no guest data, no serial number and no Firestore document id.
 */
const VERSION_PREFIX = 'IS26';

export function generateQrToken(): string {
  const raw = randomBytes(32).toString('base64url');
  return `${VERSION_PREFIX}.${raw}`;
}

export function isPlausibleToken(token: string): boolean {
  return /^IS26\.[A-Za-z0-9_-]{40,100}$/.test(token);
}
