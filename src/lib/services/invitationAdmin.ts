import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { bucket as bucketFn } from '@/lib/firebase/admin';
import { generateQrToken } from '@/lib/qr/token';
import { digestToken } from '@/lib/qr/digest';
import { resolveSerialGeometry } from '@/lib/invitation/geometry';
import { renderInvitationImage } from '@/lib/invitation/render';

type Bucket = ReturnType<typeof bucketFn>;

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

/**
 * Regenerate a card's IMAGE for an UNUSED invitation whose render was
 * broken (e.g. missing serial, wrong geometry) — this is the intended fix
 * path, not a bypass: the raw QR token is deliberately never stored in
 * Firestore (only its HMAC digest, as the document id), so the exact old
 * QR literally cannot be recreated even by us. "Regenerate" therefore
 * issues a FRESH token + fresh QR, keeps the SAME human-facing serial
 * number for continuity, renders the image with the current (fixed)
 * template geometry, and REVOKES the old invitation record so only one of
 * the two can ever be admitted. Only invitations that are still `unused`
 * qualify — a card already scanned/used must never be silently replaced.
 */
export async function regenerateInvitationImage(
  firestore: Firestore,
  bucket: Bucket,
  input: { invitationId: string; reason: string; admin: AdminActor }
): Promise<ServiceResult<{ serialNumber: string | null; newInvitationId: string; imageUrl: string }>> {
  const { invitationId, reason, admin } = input;
  const oldRef = firestore.collection('invitations').doc(invitationId);

  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };
  const oldData = oldSnap.data()!;
  if (oldData.status !== 'unused') {
    return {
      ok: false,
      code: 'NOT_UNUSED',
      message: 'Only unused invitations can be regenerated — a used or already-revoked card must not be silently replaced.',
    };
  }
  const serial = oldData.serialNumber as string;
  const eventId = oldData.eventId as string;
  const profile = (oldData.outputProfile as 'share' | 'hq') ?? 'share';

  const eventSnap = await firestore.collection('events').doc(eventId).get();
  if (!eventSnap.exists) return { ok: false, code: 'ERROR', message: 'Event not found' };
  const event = eventSnap.data()!;
  if (!event.templateId) return { ok: false, code: 'ERROR', message: 'Event has no template assigned' };

  const templateSnap = await firestore.collection('templates').doc(event.templateId as string).get();
  if (!templateSnap.exists) return { ok: false, code: 'ERROR', message: 'Template not found' };
  const template = templateSnap.data()!;

  // Render OUTSIDE any transaction — image work is slow and Firestore
  // transactions must stay short (they retry on contention).
  const [masterFile] = await bucket.file(template.storagePath as string).download();
  const token = generateQrToken();
  const digest = digestToken(token);
  const serialGeometry = resolveSerialGeometry({
    canvasWidth: template.canvasWidth as number,
    canvasHeight: template.canvasHeight as number,
    qr: template.qr as { x: number; y: number; size: number },
    serial: template.serial as never,
  });
  const image = await renderInvitationImage({
    templateBuffer: masterFile,
    geometry: {
      canvasWidth: template.canvasWidth as number,
      canvasHeight: template.canvasHeight as number,
      qr: template.qr as { x: number; y: number; size: number },
      serial: serialGeometry,
    },
    qrToken: token,
    serial,
    profile,
  });

  const storagePath = `events/${eventId}/invitations/${(oldData.batchId as string) ?? 'regenerated'}/${serial}-r${Date.now()}.jpg`;
  await bucket.file(storagePath).save(image.buffer, {
    metadata: { contentType: image.contentType, metadata: { serial, eventId, regeneratedFrom: invitationId } },
  });

  const newRef = firestore.collection('invitations').doc(digest);

  try {
    await firestore.runTransaction(async (tx) => {
      // ALL reads must complete before ANY write in a Firestore transaction.
      const freshOld = await tx.get(oldRef);
      if (!freshOld.exists) throw new RevocationError('NOT_FOUND', 'Invitation not found');
      if (freshOld.data()!.status !== 'unused') {
        throw new RevocationError('NOT_UNUSED', 'Invitation was used or revoked concurrently — regeneration aborted.');
      }
      const freshNew = await tx.get(newRef);
      if (freshNew.exists) throw new RevocationError('ERROR', 'Token collision — try again.');

      // ---- writes ----
      tx.set(newRef, {
        eventId,
        batchId: oldData.batchId ?? null,
        serialNumber: serial,
        status: 'unused',
        guestAllowance: oldData.guestAllowance ?? 1,
        imageStoragePath: storagePath,
        outputProfile: profile,
        generatedAt: FieldValue.serverTimestamp(),
        generatedBy: admin.uid,
        usedAt: null,
        usedAtClientEstimate: null,
        usedByUsherId: null,
        usedByUsherName: null,
        gateId: null,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        rescanHistory: [],
        rescanAllowedAt: null,
        rescanAllowedBy: null,
        supersedesInvitationId: invitationId,
      });
      tx.update(oldRef, {
        status: 'revoked',
        revokedAt: FieldValue.serverTimestamp(),
        revokedBy: admin.uid,
        revocationReason: reason || 'Regenerated — rendering fix',
        supersededByInvitationId: newRef.id,
      });
    });
  } catch (e) {
    if (e instanceof RevocationError) return { ok: false, code: e.code, message: e.message };
    console.error('regenerate error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not regenerate invitation image.' };
  }

  await firestore.collection('auditLogs').add({
    action: 'INVITATION_REGENERATED',
    actor: admin.uid,
    actorType: 'admin',
    detail: { oldInvitationId: invitationId, newInvitationId: newRef.id, serialNumber: serial, reason },
    at: FieldValue.serverTimestamp(),
  });

  const [imageUrl] = await bucket.file(storagePath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 10 * 60 * 1000,
  });

  return { ok: true, serialNumber: serial, newInvitationId: newRef.id, imageUrl };
}

class RevocationError extends Error {
  constructor(public code: 'NOT_FOUND' | 'NOT_UNUSED' | 'NOT_USED' | 'ERROR', message: string) {
    super(message);
  }
}

// keep Timestamp import used (usedAt typing helper)
export type UsedAtTimestamp = Timestamp;
