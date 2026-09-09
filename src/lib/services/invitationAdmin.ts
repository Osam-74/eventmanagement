import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export type AdminActor = { uid: string; displayName: string; email: string };
export type ServiceResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; code: 'NOT_FOUND' | 'NOT_UNUSED' | 'NOT_USED' | 'ERROR'; message: string };

/**
 * Revocation (fire-and-forget negative list): only an UNUSED invitation can
 * be revoked; the transition happens in a transaction so a concurrent scan
 * cannot slip past the revocation (the loser of the race either sees
 * REVOKED at the gate or the revoke fails as NOT_UNUSED).
 */
export async function revokeInvitation(
  firestore: Firestore,
  input: { invitationId: string; reason: string; admin: AdminActor }
): Promise<ServiceResult<{ serialNumber: string | null }>> {
  const { invitationId, reason, admin } = input;
  const invitationRef = firestore.collection('invitations').doc(invitationId);
  let serial: string | null = null;

  try {
    await firestore.runTransaction(async (tx) => {
      // ALL reads must complete before ANY write in a Firestore transaction.
      const snap = await tx.get(invitationRef);
      if (!snap.exists) throw new RevocationError('NOT_FOUND', 'Invitation not found');
      const data = snap.data()!;
      serial = data.serialNumber as string;
      if (data.status !== 'unused') throw new RevocationError('NOT_UNUSED', 'Only unused invitations can be revoked.');
      const eventRef = firestore.collection('events').doc(data.eventId as string);
      await tx.get(eventRef); // read before its counter write below

      // ---- writes ----
      tx.update(invitationRef, {
        status: 'revoked',
        revokedAt: FieldValue.serverTimestamp(),
        revokedBy: admin.uid,
        revocationReason: reason,
      });
      tx.update(eventRef, {
        totalRevoked: FieldValue.increment(1),
      });
    });
  } catch (e) {
    if (e instanceof RevocationError) return { ok: false, code: e.code, message: e.message };
    console.error('revoke error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not revoke invitation.' };
  }

  await firestore.collection('auditLogs').add({
    action: 'INVITATION_REVOKED',
    actor: admin.uid,
    actorType: 'admin',
    detail: { invitationId, serialNumber: serial, reason },
    at: FieldValue.serverTimestamp(),
  });
  return { ok: true, serialNumber: serial };
}

/**
 * Allow-rescan: releases a USED invitation back to UNUSED so the gate can
 * scan it again (e.g. network failure where the scan succeeded server-side
 * but the response never reached the phone). Transactional, with history
 * appended (never overwritten) and counters corrected.
 */
export async function allowRescan(
  firestore: Firestore,
  input: { invitationId: string; reason: string; admin: AdminActor }
): Promise<ServiceResult<{ serialNumber: string | null }>> {
  const { invitationId, reason, admin } = input;
  const invitationRef = firestore.collection('invitations').doc(invitationId);
  let serial: string | null = null;

  try {
    await firestore.runTransaction(async (tx) => {
      // ALL reads must complete before ANY write in a Firestore transaction.
      const snap = await tx.get(invitationRef);
      if (!snap.exists) throw new RevocationError('NOT_FOUND', 'Invitation not found');
      const data = snap.data()!;
      serial = data.serialNumber as string;
      if (data.status !== 'used')
        throw new RevocationError('NOT_USED', 'Only already-scanned (used) invitations can be released for rescan.');

      const eventRef = firestore.collection('events').doc(data.eventId as string);
      await tx.get(eventRef); // read before its counter write below

      let usherRef: ReturnType<Firestore['doc']> | null = null;
      if (data.usedByUsherId) {
        usherRef = firestore.collection('ushers').doc(data.usedByUsherId as string);
        const usherSnap = await tx.get(usherRef);
        if (!usherSnap.exists) usherRef = null;
      }

      // ---- writes ----
      tx.update(invitationRef, {
        status: 'unused',
        usedAt: null,
        usedAtClientEstimate: null,
        usedByUsherId: null,
        usedByUsherName: null,
        gateId: null,
        rescanHistory: FieldValue.arrayUnion({
          // NOTE: serverTimestamp() cannot appear inside array elements;
          // Timestamp.now() is the documented server-side equivalent here.
          at: Timestamp.now(),
          allowedBy: admin.uid,
          allowedByName: admin.displayName || admin.email,
          reason,
          previous: {
            usedAt: data.usedAt ?? null,
            usedByUsherId: data.usedByUsherId ?? null,
            usedByUsherName: data.usedByUsherName ?? null,
            gateId: data.gateId ?? null,
          },
        }),
        rescanAllowedAt: FieldValue.serverTimestamp(),
        rescanAllowedBy: admin.uid,
      });

      tx.update(eventRef, {
        totalUsed: FieldValue.increment(-1),
        rescanAllowedCount: FieldValue.increment(1),
      });

      if (usherRef) {
        tx.update(usherRef, { acceptedCount: FieldValue.increment(-1) });
      }
    });
  } catch (e) {
    if (e instanceof RevocationError) return { ok: false, code: e.code, message: e.message };
    console.error('allow-rescan error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not release invitation for rescan.' };
  }

  await firestore.collection('auditLogs').add({
    action: 'RESCAN_ALLOWED',
    actor: admin.uid,
    actorType: 'admin',
    detail: { invitationId, serialNumber: serial, reason },
    at: FieldValue.serverTimestamp(),
  });
  return { ok: true, serialNumber: serial };
}

class RevocationError extends Error {
  constructor(public code: 'NOT_FOUND' | 'NOT_UNUSED' | 'NOT_USED', message: string) {
    super(message);
  }
}

// keep Timestamp import used (usedAt typing helper)
export type UsedAtTimestamp = Timestamp;
