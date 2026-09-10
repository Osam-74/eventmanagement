import { deleteApp, initializeApp } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { generateQrToken } from '@/lib/qr/token';
import { digestToken } from '@/lib/qr/digest';
import { pinLookupIndex, pinVerifier } from '@/lib/auth/pin';

export const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

let counter = 0;
export function makeDb(): { db: Firestore; cleanup: () => Promise<void> } {
  const projectId = `demo-test-${process.pid}-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
  const app = initializeApp({ projectId }, `app-${projectId}`);
  return {
    db: getFirestore(app),
    cleanup: async () => {
      await deleteApp(app);
    },
  };
}

export const EV1 = 'event-one';
export const EV2 = 'event-two';

export async function seedEvent(
  db: Firestore,
  id: string,
  overrides: Record<string, unknown> = {}
) {
  await db.collection('events').doc(id).set({
    name: 'I & S Wedding',
    slug: 'is-wedding-2026',
    code: 'ISWED',
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
    totalCheckIns: 0,
    totalRevoked: 0,
    rescanAllowedCount: 0,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...overrides,
  });
}

export async function seedInvitation(
  db: Firestore,
  opts: {
    token?: string; eventId?: string; status?: 'unused' | 'used' | 'revoked'; serialNumber?: string;
    usedByUsherId?: string | null; tag?: string | null; usageLimit?: number | null; usageCount?: number;
  }
): Promise<{ token: string; digest: string; serial: string }> {
  const token = opts.token ?? generateQrToken();
  const digest = digestToken(token);
  const serial = opts.serialNumber ?? 'ISWED-00001';
  const status = opts.status ?? 'unused';
  // usageLimit/usageCount default to the single-use shape (limit 1) that
  // every card had before flexible generation — omitting them from opts
  // reproduces exactly what pre-existing invitation docs look like, so
  // every test written before multi-use support stays valid unchanged.
  await db.collection('invitations').doc(digest).set({
    eventId: opts.eventId ?? EV1,
    batchId: 'batch-x',
    serialNumber: serial,
    tag: opts.tag ?? null,
    usageLimit: opts.usageLimit === undefined ? 1 : opts.usageLimit,
    usageCount: opts.usageCount ?? (status === 'used' ? 1 : 0),
    status,
    guestAllowance: 1,
    imageStoragePath: `events/${EV1}/invitations/batch-x/${serial}.jpg`,
    outputProfile: 'share',
    generatedAt: FieldValue.serverTimestamp(),
    generatedBy: 'admin-x',
    firstUsedAt: status === 'used' ? FieldValue.serverTimestamp() : null,
    usedAt: status === 'used' ? FieldValue.serverTimestamp() : null,
    usedAtClientEstimate: null,
    usedByUsherId: opts.usedByUsherId ?? null,
    usedByUsherName: status === 'used' ? 'Test Usher' : null,
    gateId: null,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    rescanHistory: [],
    rescanAllowedAt: null,
    rescanAllowedBy: null,
  });
  return { token, digest, serial };
}

export async function seedUsher(
  db: Firestore,
  opts: { eventId?: string; name?: string; pin?: string; active?: boolean; lockedUntil?: Date | null; failedAttempts?: number }
): Promise<{ id: string; name: string; pin: string }> {
  const name = opts.name ?? 'Test Usher';
  const pin = opts.pin ?? '123456';
  const ref = db.collection('ushers').doc();
  // PIN-only identity: every seeded usher gets the registry entry so
  // sign-in resolves by PIN alone.
  if (opts.active ?? true) {
    await db.collection('pinRegistry').doc(pinLookupIndex(pin)).set({ usherId: ref.id, createdAt: FieldValue.serverTimestamp() });
  }
  await ref.set({
    eventId: opts.eventId ?? EV1,
    name,
    normalizedName: name.toLowerCase(),
    pinVerifier: pinVerifier(ref.id, pin),
    pinIndex: pinLookupIndex(pin),
    active: opts.active ?? true,
    gateId: null,
    failedAttempts: opts.failedAttempts ?? 0,
    lockedUntil: opts.lockedUntil ?? null,
    acceptedCount: 0,
    lastSeenAt: null,
    lastScanAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: 'admin-x',
  });
  return { id: ref.id, name, pin };
}

export async function eventDoc(db: Firestore, id = EV1) {
  const snap = await db.collection('events').doc(id).get();
  return snap.data()!;
}

export async function invitationDoc(db: Firestore, digest: string) {
  const snap = await db.collection('invitations').doc(digest).get();
  return snap.data()!;
}

export async function scanLogsFor(db: Firestore, digest: string) {
  const snap = await db.collection('scanLogs').where('tokenDigest', '==', digest).get();
  return snap.docs.map((d) => d.data());
}

export async function auditLogsFor(db: Firestore, action: string) {
  const snap = await db.collection('auditLogs').where('action', '==', action).get();
  return snap.docs.map((d) => d.data());
}

export const ACTOR = {
  uid: 'admin-actor',
  email: 'actor@test.local',
  displayName: 'Actor Admin',
  accountType: 'ADMIN' as const,
  permissions: {
    canManageAdmins: true,
    canManageEvents: true,
    canGenerateInvites: true,
    canManageInvites: true,
    canManageUshers: true,
    canViewAnalytics: true,
  },
};

export const ROOT_ACTOR = { ...ACTOR, uid: 'root-actor', accountType: 'ROOT_ADMIN' as const };
