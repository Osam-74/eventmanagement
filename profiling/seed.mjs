// Seed production-scale data into the Firestore emulator for dashboard profiling.
import { initializeApp, deleteApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIREBASE_PROJECT_ID ??= 'demo-eventaccess';

const app = initializeApp({
  credential: cert({
    clientEmail: 'seed@demo.iam',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    projectId: 'demo-eventaccess',
  }),
});
const db = getFirestore(app);
const auth = getAuth(app);

const EVENT_ID = 'perf-wedding';
const REJECTED = ['already_used', 'revoked', 'invalid', 'wrong_event', 'scanning_disabled', 'event_closed'];

const wipe = async (coll) => {
  const s = await db.collection(coll).get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
};
for (const c of ['invitations', 'scanLogs', 'ushers', 'events']) await wipe(c);

await db.collection('events').doc(EVENT_ID).set({
  name: 'I & S Wedding (perf)', slug: 'iswed-perf', code: 'ISWED',
  eventDate: new Date('2026-10-03T10:00:00Z'), timezone: 'Africa/Lagos',
  lifecycleStatus: 'active', scanningEnabled: true, scanningEnabledAt: new Date(),
  scanningEnabledBy: null, templateId: null, lastSerialSequence: 2000,
  totalGenerated: 2000, totalUsed: 850, totalRevoked: 25, rescanAllowedCount: 4,
  createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
});

// 2000 invitations
const invBatch = db.batch();
for (let i = 1; i <= 2000; i++) {
  const used = i <= 850;
  const revoked = i > 850 && i <= 875;
  invBatch.set(db.collection('invitations').doc(`seed-inv-${String(i).padStart(5, '0')}`), {
    eventId: EVENT_ID, batchId: 'batch-seed-1',
    serialNumber: `ISWED-${String(i).padStart(5, '0')}`,
    status: revoked ? 'revoked' : used ? 'used' : 'unused',
    guestAllowance: 1, outputProfile: 'share',
    generatedAt: FieldValue.serverTimestamp(), generatedBy: 'root',
    usedAt: used ? new Date(Date.now() - i * 60000) : null,
    usedByUsherId: null, usedByUsherName: used ? 'Usher ' + ((i % 20) + 1) : null,
    gateId: used ? 'gate-' + ((i % 4) + 1) : null,
    revokedAt: revoked ? new Date() : null, revokedBy: revoked ? 'root' : null,
    revocationReason: revoked ? 'test' : null,
    rescanAllowedAt: null, rescanAllowedBy: null, rescanHistory: [],
  });
}
await invBatch.commit();

// 20 ushers
const ushBatch = db.batch();
for (let i = 1; i <= 20; i++) {
  ushBatch.set(db.collection('ushers').doc(`seed-usher-${i}`), {
    eventId: EVENT_ID, name: `Usher ${i}`, pinIndex: 'x'.repeat(16) + i, pinHash: 'x', pinSalt: 'x',
    gateId: 'gate-' + ((i % 4) + 1), active: true, lockedUntil: null,
    acceptedCount: 40 + i, lastScanAt: new Date(Date.now() - i * 30000),
    lastSeenAt: i <= 5 ? new Date(Date.now() - 20000 * i) : new Date(Date.now() - 3600000 * (i - 5)),
    createdAt: FieldValue.serverTimestamp(),
  });
}
await ushBatch.commit();

// 400 scan logs (350 accepted, 50 rejected)
const logBatch = db.batch();
for (let i = 0; i < 400; i++) {
  const accepted = i < 350;
  logBatch.set(db.collection('scanLogs').doc(`seed-log-${String(i).padStart(5, '0')}`), {
    eventId: EVENT_ID, result: accepted ? 'accepted' : REJECTED[i % REJECTED.length],
    invitationSerialNumber: `ISWED-${String((i % 2000) + 1).padStart(5, '0')}`,
    invitationId: `seed-inv-${String((i % 2000) + 1).padStart(5, '0')}`,
    tokenDigest: 'seed-digest-' + i,
    usherNameSnapshot: `Usher ${(i % 20) + 1}`, usherId: `seed-usher-${(i % 20) + 1}`,
    gateId: 'gate-' + ((i % 4) + 1),
    scannedAt: new Date(Date.now() - (400 - i) * 45000),
  });
}
await logBatch.commit();

// root admin (auth + users doc)
let user;
try {
  user = await auth.getUserByEmail('perf-root@example.test');
} catch {
  user = await auth.createUser({ email: 'perf-root@example.test', password: 'perf-root-pass-12345' });
}
await db.collection('users').doc(user.uid).set({
  email: 'perf-root@example.test', displayName: 'Perf Root', accountType: 'ROOT_ADMIN',
  active: true, permissions: {}, createdAt: FieldValue.serverTimestamp(),
});

console.log(JSON.stringify({ seeded: { invitations: 2000, scanLogs: 400, ushers: 20, eventId: EVENT_ID, adminUid: user.uid } }));
await deleteApp(app);
