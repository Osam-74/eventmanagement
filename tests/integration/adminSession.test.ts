import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { NextRequest } from 'next/server';
import { getFirestore } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { seedEvent } from './helpers';
import { ADMIN_SESSION_COOKIE, createAdminSessionToken, verifyAdminSessionToken } from '@/lib/auth/adminSession';

/**
 * Route-level test of THE authoritative admin login sequence:
 *   valid Firebase ID token → users/{uid} admin record → HttpOnly
 *   admin_session cookie. Proves that a bad token, a non-admin account or
 *   a disabled admin can NEVER obtain a session, and that the session
 *   cookie alone (no Bearer) authorizes admin API calls via
 *   getAdminContext.
 */
const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
// IMPORTANT: the Auth emulator runs in single-project mode — accounts live
// under the project the emulator was started with (demo-eventaccess), and
// every REST key resolves to it. The route must therefore use THAT project,
// not a throwaway one, or emulator sign-ins return EMAIL_NOT_FOUND.
const ROUTE_PROJECT = process.env.FIREBASE_PROJECT_ID ?? 'demo-eventaccess';
if (hasEmu) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
  process.env.FIREBASE_PROJECT_ID = ROUTE_PROJECT;
  process.env.FIREBASE_CLIENT_EMAIL = `test@${ROUTE_PROJECT}.iam.gserviceaccount.com`;
  process.env.FIREBASE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.ADMIN_SESSION_SECRET ??= 'test-admin-session-secret-0123456789';
}
let db: Firestore | null = null;

async function emulatorIdToken(email: string, password: string): Promise<string> {
  const res = await fetch(
    `http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=dummy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const body = await res.json();
  if (!res.ok) throw new Error(`emulator sign-in failed: ${JSON.stringify(body)}`);
  return body.idToken as string;
}

function postSession(body: unknown): Promise<Response> {
  const req = new NextRequest('http://localhost/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req);
}

let POST: (req: NextRequest) => Promise<Response>;
let GET: (req: NextRequest) => Promise<Response>;

describe.skipIf(!hasEmu)('admin session route (authoritative login sequence)', () => {
  const ROOT_EMAIL = 'root-admin@example.test';
  const ROOT_PASSWORD = 'correct-horse-battery-1';
  const PLAIN_EMAIL = 'plain-user@example.test';
  const PLAIN_PASSWORD = 'plain-user-pass-123';
  const DISABLED_EMAIL = 'disabled-admin@example.test';
  let rootUid = '';
  let plainUid = '';
  let disabledUid = '';

  beforeAll(async () => {
    ({ POST, GET } = await import('@/app/api/auth/session/route'));
    const { getApps, initializeApp, deleteApp } = await import('firebase-admin/app');
    const app = getApps().find((a) => a.name === ROUTE_PROJECT) ?? initializeApp({ projectId: ROUTE_PROJECT }, ROUTE_PROJECT);
    const { getAuth } = await import('firebase-admin/auth');
    const auth = getAuth(app);
    db = getFirestore(app);

    await seedEvent(db, 'event-admin-session');
    rootUid = (await auth.createUser({ email: ROOT_EMAIL, password: ROOT_PASSWORD })).uid;
    plainUid = (await auth.createUser({ email: PLAIN_EMAIL, password: PLAIN_PASSWORD })).uid;
    disabledUid = (await auth.createUser({ email: DISABLED_EMAIL, password: 'disabled-pass-12345' })).uid;

    await db.collection('users').doc(rootUid).set({
      email: ROOT_EMAIL,
      displayName: 'Root Admin',
      accountType: 'ROOT_ADMIN',
      permissions: {},
      active: true,
    });
    // plain signed-in Firebase user with NO admin record
    await db.collection('users').doc(plainUid).set({
      email: PLAIN_EMAIL,
      displayName: 'Plain User',
      accountType: 'GUEST',
      permissions: {},
      active: true,
    });
    await db.collection('users').doc(disabledUid).set({
      email: DISABLED_EMAIL,
      displayName: 'Disabled Admin',
      accountType: 'ADMIN',
      permissions: {},
      active: false,
    });
    await deleteApp(app).catch(() => undefined);
  });

  it('signs the response cookie in with HttpOnly, SameSite=Lax, path=/', async () => {
    const idToken = await emulatorIdToken(ROOT_EMAIL, ROOT_PASSWORD);
    const res = await postSession({ idToken });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(setCookie).toMatch(/httponly/i);
    expect(setCookie).toMatch(/samesite=(lax|strict)/i);
    expect(setCookie).toMatch(/path=\//i);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.admin.accountType).toBe('ROOT_ADMIN');
  });

  it('rejects a wrong password (no token ever minted)', async () => {
    const req = new NextRequest('http://localhost/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: 'not-a-token' }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
    expect(res.headers.get('set-cookie')).toBe(null);
  });

  it('rejects a valid Firebase account that is NOT an administrator', async () => {
    const idToken = await emulatorIdToken(PLAIN_EMAIL, PLAIN_PASSWORD);
    const res = await postSession({ idToken });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBe(null);
  });

  it('rejects a disabled administrator', async () => {
    const idToken = await emulatorIdToken(DISABLED_EMAIL, 'disabled-pass-12345');
    const res = await postSession({ idToken });
    expect(res.status).toBe(401);
  });

  it('GET resolves the admin from the cookie session and nulls out for a disabled admin', async () => {
    const token = createAdminSessionToken(rootUid);
    const good = new NextRequest('http://localhost/api/auth/session', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
    });
    const body = await (await GET(good)).json();
    expect(body.admin?.accountType).toBe('ROOT_ADMIN');

    // The session is a POINTER — disabling the record kills it immediately
    await db!.collection('users').doc(rootUid).update({ active: false });
    const bad = new NextRequest('http://localhost/api/auth/session', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
    });
    const revoked = await (await GET(bad)).json();
    expect(revoked.admin).toBeNull();
    await db!.collection('users').doc(rootUid).update({ active: true });
  });

  it('GET is null without a session cookie (no client-state fallback)', async () => {
    const res = await GET(new NextRequest('http://localhost/api/auth/session'));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.admin).toBeNull();
  });

  it('tampered / expired session tokens never verify', () => {
    expect(verifyAdminSessionToken('garbage')).toBeNull();
    const token = createAdminSessionToken(rootUid);
    const parts = token.split('.');
    expect(verifyAdminSessionToken(`${parts[0]}.forged-signature`)).toBeNull();
    expect(verifyAdminSessionToken(null)).toBeNull();
  });
});
