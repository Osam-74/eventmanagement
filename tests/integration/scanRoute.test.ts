import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { seedEvent, seedInvitation, seedUsher, EV1 } from './helpers';
import { createUsherSessionToken, verifyUsherSessionToken } from '@/lib/auth/usherSession';

/**
 * Route-level test of the scanner's protected operation: proves the
 * HttpOnly session cookie is what authorizes a scan, and that a missing,
 * tampered or expired session cannot scan even with a perfect request body.
 */
const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
// The route under test uses its OWN lazy firebase-admin singleton, so the
// test drives that singleton at the emulator with a throwaway credential.
// Env must be prepared at MODULE scope — before any lazy route import.
const ROUTE_PROJECT = 'demo-route-test';
if (hasEmu) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  process.env.FIREBASE_PROJECT_ID = ROUTE_PROJECT;
  process.env.FIREBASE_CLIENT_EMAIL = `test@${ROUTE_PROJECT}.iam.gserviceaccount.com`;
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}
let db: Firestore | null = null;

describe.skipIf(!hasEmu)('scan route session enforcement', () => {
  let POST: (req: NextRequest) => Promise<Response>;
  let usher: { id: string; name: string };

  beforeAll(async () => {
    ({ POST } = await import('@/app/api/scan/route'));
    const { getApps, initializeApp, deleteApp } = await import('firebase-admin/app');
    const app = getApps().find((a) => a.name === ROUTE_PROJECT) ?? initializeApp({ projectId: ROUTE_PROJECT }, ROUTE_PROJECT);
    db = getFirestore(app);
    await seedEvent(db, EV1);
    usher = await seedUsher(db, {});
    await deleteApp(app).catch(() => undefined);
  });
  afterAll(async () => {});

  const req = (body: object, cookie?: string) =>
    new NextRequest('http://localhost/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  it('valid session cookie + valid card → ACCEPTED (200)', async () => {
    const inv = await seedInvitation(db!, { serialNumber: 'ISWED-00090' });
    const token = createUsherSessionToken({ usherId: usher.id, usherName: usher.name, eventId: EV1 });
    const res = await POST(req({
      token: inv.token,
      clientRequestId: 'req-route-1',
      gateId: 'gate-1',
    }, `usher_session=${token}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe('ACCEPTED');
    expect(body.serialNumber).toBe(inv.serial);
  });

  it('missing session cookie → 401, nothing consumed', async () => {
    const inv = await seedInvitation(db!, { serialNumber: 'ISWED-00091' });
    const res = await POST(req({ token: inv.token, clientRequestId: 'req-route-2' }));
    expect(res.status).toBe(401);
    const doc = (await db!.collection('invitations').doc((await import('@/lib/qr/digest')).digestToken(inv.token)).get()).data()!;
    expect(doc.status).toBe('unused');
  });

  it('garbage/tampered session cookie → 401', async () => {
    const inv = await seedInvitation(db!, { serialNumber: 'ISWED-00092' });
    for (const bad of ['garbage', `${'x'.repeat(40)}.${'y'.repeat(44)}`]) {
      const res = await POST(req({ token: inv.token, clientRequestId: 'req-route-3' }, `usher_session=${bad}`));
      expect(res.status).toBe(401);
    }
  });

  it('expired session token cannot scan', async () => {
    const expired = `${Buffer.from(
      JSON.stringify({ usherId: usher.id, eventId: EV1, exp: Math.floor(Date.now() / 1000) - 100 })
    ).toString('base64url')}.${'z'.repeat(44)}`;
    expect(verifyUsherSessionToken(expired)).toBeNull();
    const inv = await seedInvitation(db!, { serialNumber: 'ISWED-00093' });
    const res = await POST(req({ token: inv.token, clientRequestId: 'req-route-4' }, `usher_session=${expired}`));
    expect(res.status).toBe(401);
  });
});
