import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { createUsherSessionToken, verifyUsherSessionToken } from '@/lib/auth/usherSession';
import { createAdminSessionToken, verifyAdminSessionToken } from '@/lib/auth/adminSession';
import { pinLookupIndex, pinVerifier } from '@/lib/auth/pin';

const SECRET = process.env.USHER_SESSION_SECRET!;

function forge(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

describe('usher session tokens', () => {
  it('round-trips a valid token', () => {
    const t = createUsherSessionToken({ usherId: 'u1', usherName: 'Grace', eventId: 'e1' });
    const p = verifyUsherSessionToken(t);
    expect(p).not.toBeNull();
    expect(p!.usherId).toBe('u1');
    expect(p!.eventId).toBe('e1');
  });

  it('rejects expired tokens (session cannot be used after TTL)', () => {
    const t = forge({ usherId: 'u1', eventId: 'e1', exp: Math.floor(Date.now() / 1000) - 60 });
    expect(verifyUsherSessionToken(t)).toBeNull();
  });

  it('rejects tampered payloads (signature covers the body)', () => {
    const t = createUsherSessionToken({ usherId: 'u1', usherName: 'Grace', eventId: 'e1' });
    const [body, sig] = t.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
    decoded.usherId = 'someone-else';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + sig;
    expect(verifyUsherSessionToken(tampered)).toBeNull();
  });

  it('rejects garbage and wrong-secret signatures', () => {
    expect(verifyUsherSessionToken(undefined)).toBeNull();
    expect(verifyUsherSessionToken('nope')).toBeNull();
    const body = Buffer.from(JSON.stringify({ usherId: 'u1', eventId: 'e1', exp: 99999999999 })).toString('base64url');
    const badSig = createHmac('sha256', 'wrong-secret').update(body).digest('base64url');
    expect(verifyUsherSessionToken(`${body}.${badSig}`)).toBeNull();
  });
});

describe('usher PIN verifier', () => {
  it('is deterministic and keyed to both the usher id and the server pepper', () => {
    const a = pinVerifier('usher-1', '123456');
    expect(a).toBe(pinVerifier('usher-1', '123456'));
    expect(a).not.toBe(pinVerifier('usher-2', '123456')); // different usher
    expect(a).not.toBe(pinVerifier('usher-1', '123457')); // different pin
    expect(a).not.toContain('123456'); // never the plaintext
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('admin session tokens (server-established login authority)', () => {
  it('round-trips a valid admin session', () => {
    const t = createAdminSessionToken('admin-uid-1');
    const p = verifyAdminSessionToken(t);
    expect(p).not.toBeNull();
    expect(p!.uid).toBe('admin-uid-1');
  });

  it('rejects expired admin sessions', () => {
    const body = Buffer.from(JSON.stringify({ uid: 'u', exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url');
    const sig = createHmac('sha256', process.env.ADMIN_SESSION_SECRET ?? process.env.USHER_SESSION_SECRET!).update(body).digest('base64url');
    expect(verifyAdminSessionToken(`${body}.${sig}`)).toBeNull();
  });

  it('rejects forged signatures and malformed tokens', () => {
    const t = createAdminSessionToken('u');
    const [body] = t.split('.');
    expect(verifyAdminSessionToken(`${body}.forged`)).toBeNull();
    expect(verifyAdminSessionToken('one-part')).toBeNull();
    expect(verifyAdminSessionToken('')).toBeNull();
    expect(verifyAdminSessionToken(undefined)).toBeNull();
  });

  it('never carries credentials — only a uid pointer and expiry', () => {
    const t = createAdminSessionToken('admin-uid-2');
    const [body] = t.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['exp', 'uid']);
  });
});

describe('PIN-only identification cryptography', () => {
  it('pinLookupIndex is deterministic and never exposes the PIN', () => {
    const a = pinLookupIndex('135790');
    const b = pinLookupIndex('135790');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(pinLookupIndex('135790')).not.toBe(pinLookupIndex('135791'));
    expect(a).not.toContain('135790');
  });

  it('pinLookupIndex and pinVerifier are distinct keyed derivations', () => {
    const idx = pinLookupIndex('123456');
    const verifier = pinVerifier('usher-x', '123456');
    expect(idx).not.toBe(verifier);
    expect(pinVerifier('usher-x', '123456')).not.toBe(pinVerifier('usher-y', '123456'));
  });
});
