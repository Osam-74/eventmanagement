/**
 * E2E global setup:
 *  1. production build (unless BUILD_E2E=skip) — with the client SDK
 *     pointed at the Firebase Auth emulator (test builds only)
 *  2. generate a throwaway service-account key (never a real secret; the
 *     emulators ignore credentials — this only lets the server boot)
 *  3. spawn `next start` on port 3111 with emulator + test-secret env
 *  4. seed one active event, one PIN-only usher, and one ROOT_ADMIN auth
 *     account (Auth emulator) in the emulators
 * Test files read BASE_URL / credentials from process.env (set here).
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { pinLookupIndex, pinVerifier } from '@/lib/auth/pin';

const PORT = 3111;
const EVENT_ID = 'e2e-wedding';
const USHER_NAME = 'Ada E2E';
const USHER_PIN = '135790';
const ADMIN_EMAIL = 'e2e-root@example.test';
const ADMIN_PASSWORD = 'e2e-root-pass-12345';

export default async function setup() {
  // Test secrets must exist before any crypto helpers run (no setup files
  // in this vitest config). Defaults keep local + CI deterministic.
  process.env.QR_TOKEN_HMAC_KEY ??= 'e2e-test-secret-key-for-hmac-32bytes!!';
  process.env.USHER_PIN_PEPPER ??= 'e2e-test-pin-pepper';
  process.env.USHER_SESSION_SECRET ??= 'e2e-test-session-secret';
  process.env.ADMIN_SESSION_SECRET ??= 'e2e-test-admin-session-secret';
  // Client SDK → Auth emulator. BUILD-time env: compiled into the test
  // bundle only; production builds never see it.
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;

  if (process.env.BUILD_E2E !== 'skip' || !existsSync(path.resolve('.next/BUILD_ID'))) {
    execSync('npx next build', { stdio: 'inherit', env: process.env });
  }

  // Throwaway RSA key — lets admin.credential.cert() construct without any
  // real secret. The emulator never uses it for authentication.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serverEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(PORT),
    NODE_ENV: 'production',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? 'demo-eventaccess',
    FIREBASE_CLIENT_EMAIL: 'e2e@demo-eventaccess.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    FIREBASE_STORAGE_BUCKET: 'demo-eventaccess.appspot.com',
    QR_TOKEN_HMAC_KEY: process.env.QR_TOKEN_HMAC_KEY ?? 'e2e-test-secret-key-for-hmac-32bytes!!',
    USHER_PIN_PEPPER: process.env.USHER_PIN_PEPPER ?? 'e2e-test-pin-pepper',
    USHER_SESSION_SECRET: process.env.USHER_SESSION_SECRET ?? 'e2e-test-session-secret',
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET ?? 'e2e-test-admin-session-secret',
  };

  const server: ChildProcess = spawn('npx', ['next', 'start'], {
    env: serverEnv as unknown as NodeJS.ProcessEnv,
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/me`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('E2E server did not become ready');

  // Seed event + usher + root admin through the same emulators the server talks to.
  const projectId = serverEnv.FIREBASE_PROJECT_ID;
  const seedApp = initializeApp({ projectId }, 'e2e-seed');
  const db = getFirestore(seedApp);
  await db.collection('events').doc(EVENT_ID).set({
    name: 'I & S Wedding (E2E)',
    slug: 'e2e-wedding',
    code: 'E2E',
    eventDate: new Date('2026-10-03T10:00:00Z'),
    timezone: 'Africa/Lagos',
    lifecycleStatus: 'open',
    scanningEnabled: true,
    scanningEnabledAt: null,
    scanningEnabledBy: null,
    templateId: null,
    lastSerialSequence: 0,
    totalGenerated: 0,
    totalUsed: 0,
    totalRevoked: 0,
    rescanAllowedCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // PIN-only usher: registry entry + index (mirrors production data model).
  const ref = db.collection('ushers').doc();
  await db.collection('pinRegistry').doc(pinLookupIndex(USHER_PIN)).set({
    usherId: ref.id,
    createdAt: FieldValue.serverTimestamp(),
  });
  await ref.set({
    eventId: EVENT_ID,
    name: USHER_NAME,
    normalizedName: USHER_NAME.toLowerCase(),
    active: true,
    gateId: 'GATE-1',
    acceptedCount: 0,
    lockedUntil: null,
    failedAttempts: 0,
    lastSeenAt: null,
    lastScanAt: null,
    pinVerifier: pinVerifier(ref.id, USHER_PIN),
    pinIndex: pinLookupIndex(USHER_PIN),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Root admin (Auth emulator account + authorization record).
  const auth = getAuth(seedApp);
  const adminUser = await auth
    .createUser({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, displayName: 'E2E Root Admin' })
    .catch((err) => err.errorInfo?.code === 'auth/email-already-exists'
      ? auth.getUserByEmail(ADMIN_EMAIL)
      : Promise.reject(err));
  await db.collection('users').doc(adminUser.uid).set({
    email: ADMIN_EMAIL,
    displayName: 'E2E Root Admin',
    accountType: 'ROOT_ADMIN',
    permissions: {},
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await deleteApp(seedApp);

  process.env.E2E_BASE_URL = base;
  process.env.E2E_EVENT_ID = EVENT_ID;
  process.env.E2E_USHER_NAME = USHER_NAME;
  process.env.E2E_USHER_PIN = USHER_PIN;
  process.env.E2E_ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.E2E_ADMIN_PASSWORD = ADMIN_PASSWORD;

  return async function teardown() {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  };
}
