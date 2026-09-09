import { createHmac, timingSafeEqual } from 'crypto';

export type UsherSessionPayload = {
  usherId: string;
  usherName: string;
  eventId: string;
  exp: number; // epoch seconds
};

const COOKIE_NAME = 'usher_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

function secret(): string {
  const s = process.env.USHER_SESSION_SECRET;
  if (!s) throw new Error('USHER_SESSION_SECRET is not configured.');
  return s;
}

function sign(data: string): string {
  return createHmac('sha256', secret()).update(data).digest('base64url');
}

export function createUsherSessionToken(payload: Omit<UsherSessionPayload, 'exp'>): string {
  const full: UsherSessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyUsherSessionToken(token: string | undefined | null): UsherSessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as UsherSessionPayload;
    if (!payload.usherId || !payload.eventId) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const USHER_SESSION_COOKIE = COOKIE_NAME;
export const USHER_SESSION_MAX_AGE = SESSION_TTL_SECONDS;
