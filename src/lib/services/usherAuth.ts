import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { pinVerifier } from '@/lib/auth/pin';
import { safeEqual } from '@/lib/qr/digest';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export type SignInResult =
  | { ok: true; usher: { id: string; name: string } }
  | { ok: false; code: 'NOT_FOUND' | 'DISABLED' | 'LOCKED' | 'INVALID'; message: string; lockedMinutes?: number };

export async function usherSignIn(
  firestore: Firestore,
  input: { eventId: string; name: string; pin: string }
): Promise<SignInResult> {
  const { eventId, name, pin } = input;
  const normalizedName = name.trim().toLowerCase();

  const snap = await firestore
    .collection('ushers')
    .where('eventId', '==', eventId)
    .where('normalizedName', '==', normalizedName)
    .limit(1)
    .get();
  const usherDoc = snap.docs[0];
  if (!usherDoc) {
    // uniform error — do not reveal whether the name exists
    return { ok: false, code: 'INVALID', message: 'Invalid name or PIN.' };
  }
  const ref = usherDoc.ref;
  const data = usherDoc.data();

  if (data.active !== true) {
    return { ok: false, code: 'DISABLED', message: 'This usher access is disabled. See an administrator.' };
  }

  const lockedUntil = data.lockedUntil as Timestamp | null;
  if (lockedUntil && lockedUntil.toMillis() > Date.now()) {
    const mins = Math.ceil((lockedUntil.toMillis() - Date.now()) / 60000);
    return { ok: false, code: 'LOCKED', message: `Too many failed attempts. Try again in ~${mins} minute(s).`, lockedMinutes: mins };
  }

  const expected = data.pinVerifier as string;
  const actual = pinVerifier(usherDoc.id, pin);
  if (!safeEqual(expected, actual)) {
    const failedAttempts = ((data.failedAttempts as number) ?? 0) + 1;
    const update: Record<string, unknown> = { failedAttempts, updatedAt: FieldValue.serverTimestamp() };
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = Timestamp.fromMillis(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      update.failedAttempts = 0;
    }
    await ref.update(update);
    return { ok: false, code: 'INVALID', message: 'Invalid name or PIN.' };
  }

  // success — clear lockout bookkeeping and mark presence
  await ref.update({
    failedAttempts: 0,
    lockedUntil: null,
    lastSeenAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, usher: { id: usherDoc.id, name: data.name as string } };
}

/**
 * Loads an usher for a session and returns null unless the usher is active.
 * Every protected scanner operation must re-check this server-side.
 */
export async function verifyUsherActive(
  firestore: Firestore,
  usherId: string
): Promise<{ id: string; name: string; gateId: string | null; acceptedCount: number } | null> {
  const snap = await firestore.collection('ushers').doc(usherId).get();
  if (!snap.exists || snap.data()?.active !== true) return null;
  const d = snap.data()!;
  return {
    id: snap.id,
    name: d.name as string,
    gateId: (d.gateId as string | null) ?? null,
    acceptedCount: (d.acceptedCount as number) ?? 0,
  };
}
