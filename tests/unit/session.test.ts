import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { createUsherSessionToken, verifyUsherSessionToken } from '@/lib/auth/usherSession';
import { pinVerifier } from '@/lib/auth/pin';

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
