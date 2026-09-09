import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Admin session token — HMAC-signed { uid, exp }, carried in the
 * `admin_session` HttpOnly cookie. This is the SERVER-ESTABLISHED session
 * created only after a Firebase ID token has been verified and the admin
 * authorization record checked (see /api/auth/session).
 *
 * The cookie is a POINTER, not proof by itself: every admin API call
 * re-loads users/{uid} through getAdminContext, so disabling an admin or
 * changing permissions takes effect immediately, and the session can be
 * revoked server-side (delete/disable the record) at any time.
 *
 * The client never derives authenticated UI state from Firebase client
 * auth — only from this session. That makes login deterministic:
 * Firebase sign-in → ID token → server validation → session cookie →
 * only then a redirect to /admin.
 */
export type AdminSessionPayload = {
  uid: string;
  exp: number; // epoch seconds
};

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

function secret(): string {
  // ADMIN_SESSION_SECRET is preferred; the usher session secret is a
  // fallback so a deployment that only set USHER_SESSION_SECRET stays
  // secure (it is documented in the deployment plan as a required secret).
  const s = process.env.ADMIN_SESSION_SECRET ?? process.env.USHER_SESSION_SECRET;
  if (!s) throw new Error('ADMIN_SESSION_SECRET (or USHER_SESSION_SECRET) is not configured.');
  return s;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createAdminSessionToken(uid: string): string {
  const payload: AdminSessionPayload = { uid, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyAdminSessionToken(token: string | undefined | null): AdminSessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AdminSessionPayload;
    if (!payload.uid) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const ADMIN_SESSION_COOKIE = COOKIE_NAME;
export const ADMIN_SESSION_MAX_AGE = SESSION_TTL_SECONDS;
