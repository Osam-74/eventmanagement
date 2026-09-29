import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { bucket as bucketFn } from '@/lib/firebase/admin';
import { generateQrToken } from '@/lib/qr/token';
import { digestToken } from '@/lib/qr/digest';
import { resolveSerialGeometry, resolveQrBoxGeometry, resolveAccessLabelGeometry, resolveQrGeometry } from '@/lib/invitation/geometry';
import { renderInvitationImage } from '@/lib/invitation/render';
import { retagInvitationImage } from '@/lib/invitation/retag';

type Bucket = ReturnType<typeof bucketFn>;

export type AdminActor = { uid: string; displayName: string; email: string };
export type ServiceResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; code: 'NOT_FOUND' | 'NOT_UNUSED' | 'NOT_USED' | 'BELOW_USED' | 'REVOKED' | 'ERROR'; message: string };

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

      // Multi-use cards (owner request, 2026-09-10): releasing an exhausted
      // card gives back exactly ONE use rather than resetting to zero — a
      // card exhausted at usageCount 5/5 becomes 4/5, so the gate can admit
      // it once more. Legacy invitations have no usageCount field at all;
      // treat that as "1 of a 1-use card", which decrements to 0 — the
      // exact pre-existing behavior. Written as a plain number, not
      // FieldValue.increment, so a missing field is never misread as 0.
      const currentUsageCount = (data.usageCount as number | undefined) ?? 1;
      const releasedUsageCount = Math.max(currentUsageCount - 1, 0);

      // ---- writes ----
      tx.update(invitationRef, {
        status: 'unused',
        usageCount: releasedUsageCount,
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
  const tag = (oldData.tag as string | null) ?? null;
  const usageLimit = oldData.usageLimit === undefined ? 1 : (oldData.usageLimit as number | null);
  const eventId = oldData.eventId as string;
  const profile = (oldData.outputProfile as 'share' | 'hq') ?? 'share';
  // What's actually drawn on the card face — same rule as first generation:
  // a tag replaces the serial visually; the serial itself is unchanged.
  const cardText = tag ?? serial;

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
  // BUG fix (2026-09-11): recompute from the current ratios, never read the
  // position frozen on the template document at upload time — see
  // resolveQrGeometry() in geometry.ts.
  const qrGeometry = resolveQrGeometry(template.canvasWidth as number, template.canvasHeight as number, template.qrOverride as never);
  const serialGeometry = resolveSerialGeometry({
    canvasWidth: template.canvasWidth as number,
    canvasHeight: template.canvasHeight as number,
    qr: qrGeometry,
    serial: template.serial as never,
  });
  const accessLabelGeometry = resolveAccessLabelGeometry({
    canvasWidth: template.canvasWidth as number,
    canvasHeight: template.canvasHeight as number,
    qr: qrGeometry,
  });
  const image = await renderInvitationImage({
    templateBuffer: masterFile,
    geometry: {
      canvasWidth: template.canvasWidth as number,
      canvasHeight: template.canvasHeight as number,
      qr: qrGeometry,
      accessLabel: accessLabelGeometry,
      serial: serialGeometry,
      qrBox: resolveQrBoxGeometry(template.qrBox as never),
    },
    qrToken: token,
    serial: cardText,
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
        tag,
        usageLimit,
        usageCount: 0,
        status: 'unused',
        guestAllowance: oldData.guestAllowance ?? 1,
        imageStoragePath: storagePath,
        outputProfile: profile,
        generatedAt: FieldValue.serverTimestamp(),
        generatedBy: admin.uid,
        firstUsedAt: null,
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

/**
 * Pure decision for a scan-allowance edit — exported so every rule is
 * unit-testable without Firestore. Given the card's current state and the
 * requested new limit, returns either the next status + how the event's
 * `totalUsed` counter must move, or the reason the edit is refused.
 *
 * Rules (they exist so an edit can never cause a scan problem):
 *  - a revoked card is never edited (it is dead on purpose)
 *  - the new limit can never be BELOW the uses already consumed — that
 *    would retroactively make past, valid admissions "over the limit"
 *  - status is always re-derived from the numbers, never trusted:
 *      used >= limit  → 'used'   (locked, exactly like a naturally
 *                                 exhausted card)
 *      otherwise      → 'unused' (scannable)
 *    so raising the limit on an exhausted card REOPENS it, and lowering it
 *    to exactly the uses consumed LOCKS it.
 *  - `totalUsed` counts exhausted CARDS (see scan.ts), so it moves by +1
 *    when an edit exhausts a card, -1 when it reopens one, 0 otherwise.
 */
export type UsageLimitDecision =
  | { ok: true; nextStatus: 'used' | 'unused'; totalUsedDelta: -1 | 0 | 1; changed: boolean }
  | { ok: false; code: 'REVOKED' | 'BELOW_USED'; message: string };

export function decideUsageLimitChange(
  current: { status: string; usageCount: number; usageLimit: number | null },
  newLimit: number | null
): UsageLimitDecision {
  if (current.status === 'revoked') {
    return { ok: false, code: 'REVOKED', message: 'A revoked card cannot be edited.' };
  }
  const used = current.usageCount;
  if (newLimit !== null && newLimit < used) {
    return {
      ok: false,
      code: 'BELOW_USED',
      message: `This card has already been scanned ${used} time${used === 1 ? '' : 's'}, so the limit cannot be lower than ${used}.`,
    };
  }
  const wasExhausted = current.status === 'used';
  const willBeExhausted = newLimit !== null && used >= newLimit;
  const nextStatus = willBeExhausted ? 'used' : 'unused';
  const totalUsedDelta = wasExhausted === willBeExhausted ? 0 : willBeExhausted ? 1 : -1;
  return { ok: true, nextStatus, totalUsedDelta, changed: newLimit !== current.usageLimit };
}

/**
 * Edit how many times an existing card may be scanned — increase, reduce, or
 * switch to unlimited — WITHOUT touching the card itself. The QR token, its
 * digest (the document id) and the printed image are all unchanged, so a
 * card that is already printed or shared keeps working and needs no
 * reprint. Only the allowance stored server-side changes.
 *
 * Runs in ONE transaction that reads the live card first, so it is
 * serialized against gate scans: a scan racing this edit either commits
 * before it (and the edit is validated against the true post-scan count)
 * or after it (and sees the new limit). No lost update, no double count.
 * Reads happen before writes (Firestore requirement).
 */
export async function updateInvitationUsageLimit(
  firestore: Firestore,
  input: { invitationId: string; usageLimit: number | null; reason: string; admin: AdminActor }
): Promise<ServiceResult<{ serialNumber: string | null; usageCount: number; usageLimit: number | null; status: 'used' | 'unused'; changed: boolean }>> {
  const { invitationId, usageLimit: newLimit, reason, admin } = input;
  const invitationRef = firestore.collection('invitations').doc(invitationId);
  let audit: { serial: string | null; previous: number | null; usageCount: number; status: 'used' | 'unused'; changed: boolean } | null = null;

  try {
    await firestore.runTransaction(async (tx) => {
      // ---- reads ----
      const snap = await tx.get(invitationRef);
      if (!snap.exists) throw new RevocationError('NOT_FOUND', 'Invitation not found');
      const data = snap.data()!;
      const eventRef = firestore.collection('events').doc(data.eventId as string);
      await tx.get(eventRef); // read before its counter write below

      // Legacy cards carry no usageLimit / usageCount field: treat exactly
      // as scan.ts does — a 1-use card, with usageCount inferred from status.
      const previous = data.usageLimit === undefined ? 1 : (data.usageLimit as number | null);
      const usageCount =
        (data.usageCount as number | undefined) ?? (data.status === 'used' ? 1 : 0);

      const decision = decideUsageLimitChange(
        { status: data.status as string, usageCount, usageLimit: previous },
        newLimit
      );
      if (!decision.ok) throw new RevocationError(decision.code, decision.message);

      audit = { serial: data.serialNumber as string, previous, usageCount, status: decision.nextStatus, changed: decision.changed };
      if (!decision.changed) return; // nothing to write — idempotent no-op

      // ---- writes ----
      tx.update(invitationRef, {
        usageLimit: newLimit,
        // Persist the count explicitly so a legacy card (no usageCount) is
        // migrated to the modern shape the moment it is edited.
        usageCount,
        status: decision.nextStatus,
      });
      if (decision.totalUsedDelta !== 0) {
        tx.update(eventRef, { totalUsed: FieldValue.increment(decision.totalUsedDelta) });
      }
    });
  } catch (e) {
    if (e instanceof RevocationError) return { ok: false, code: e.code, message: e.message };
    console.error('update usage limit error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not update the scan limit.' };
  }

  const a = audit!;
  if (a.changed) {
    await firestore.collection('auditLogs').add({
      action: 'INVITATION_USAGE_LIMIT_CHANGED',
      actor: admin.uid,
      actorType: 'admin',
      detail: { invitationId, serialNumber: a.serial, from: a.previous, to: newLimit, usageCount: a.usageCount, reason },
      at: FieldValue.serverTimestamp(),
    });
  }
  return { ok: true, serialNumber: a.serial, usageCount: a.usageCount, usageLimit: newLimit, status: a.status, changed: a.changed };
}

/**
 * Change the tag printed on an EXISTING card (or clear it so the serial is
 * printed again) WITHOUT changing its QR code.
 *
 * The invitation's document id is the digest of its QR token, so as long as
 * the id is unchanged the QR on every guest's copy still scans. This never
 * creates a new token or document and never revokes anything: it repaints
 * only the serial/tag plate on the stored card image (see retag.ts), saves
 * it to a new storage path, points the document at it, and only then
 * deletes the previous image file — so a failure part-way leaves a working
 * card, never a broken one.
 *
 * `newTag`: the text to print (already validated/uppercased by the caller),
 * or null/'' to print the card's serial number instead.
 */
export async function updateInvitationTag(
  firestore: Firestore,
  bucket: Bucket,
  input: { invitationId: string; newTag: string | null; reason: string; admin: AdminActor }
): Promise<ServiceResult<{ serialNumber: string | null; tag: string | null; printed: string; changed: boolean; imageUrl: string | null }>> {
  const { invitationId, reason, admin } = input;
  const nextTag = input.newTag && input.newTag.trim() ? input.newTag.trim() : null;
  const ref = firestore.collection('invitations').doc(invitationId);

  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Invitation not found' };
  const data = snap.data()!;
  if (data.status === 'revoked') {
    return { ok: false, code: 'REVOKED', message: 'A revoked card cannot be edited.' };
  }
  const serial = data.serialNumber as string;
  const oldTag = (data.tag as string | null) ?? null;
  const oldText = oldTag ?? serial;
  const newText = nextTag ?? serial;
  if (oldText === newText) {
    return { ok: true, serialNumber: serial, tag: oldTag, printed: oldText, changed: false, imageUrl: null };
  }
  const oldPath = data.imageStoragePath as string | undefined;
  if (!oldPath) return { ok: false, code: 'ERROR', message: 'This card has no stored image to edit.' };

  const eventId = data.eventId as string;
  const profile = (data.outputProfile as 'share' | 'hq') ?? 'share';
  const eventSnap = await firestore.collection('events').doc(eventId).get();
  if (!eventSnap.exists || !eventSnap.data()!.templateId) return { ok: false, code: 'ERROR', message: 'Event has no template assigned' };
  const templateSnap = await firestore.collection('templates').doc(eventSnap.data()!.templateId as string).get();
  if (!templateSnap.exists) return { ok: false, code: 'ERROR', message: 'Template not found' };
  const template = templateSnap.data()!;

  let newPath: string;
  try {
    const [existingCard] = await bucket.file(oldPath).download();
    const [templateBuffer] = await bucket.file(template.storagePath as string).download();
    const qrGeometry = resolveQrGeometry(template.canvasWidth as number, template.canvasHeight as number, template.qrOverride as never);
    const geometry = {
      canvasWidth: template.canvasWidth as number,
      canvasHeight: template.canvasHeight as number,
      qr: qrGeometry,
      accessLabel: resolveAccessLabelGeometry({ canvasWidth: template.canvasWidth as number, canvasHeight: template.canvasHeight as number, qr: qrGeometry }),
      serial: resolveSerialGeometry({ canvasWidth: template.canvasWidth as number, canvasHeight: template.canvasHeight as number, qr: qrGeometry, serial: template.serial as never }),
      qrBox: resolveQrBoxGeometry(template.qrBox as never),
    };
    const { buffer } = await retagInvitationImage({ existingCard, templateBuffer, geometry, oldText, newText, profile });
    newPath = `events/${eventId}/invitations/${(data.batchId as string) ?? 'edited'}/${serial}-t${Date.now()}.jpg`;
    await bucket.file(newPath).save(buffer, {
      contentType: 'image/jpeg',
      metadata: { contentType: 'image/jpeg', metadata: { serial, eventId, retaggedFrom: oldPath } },
    });
  } catch (e) {
    console.error('retag render error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not update the card image. Nothing was changed.' };
  }

  try {
    await firestore.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) throw new RevocationError('NOT_FOUND', 'Invitation not found');
      if (fresh.data()!.status === 'revoked') throw new RevocationError('REVOKED', 'The card was revoked while editing.');
      // Someone else retagged it while we rendered: don't silently overwrite their change.
      if (fresh.data()!.imageStoragePath !== oldPath) throw new RevocationError('ERROR', 'This card was edited by someone else. Reload and try again.');
      tx.update(ref, { tag: nextTag, imageStoragePath: newPath });
    });
  } catch (e) {
    await bucket.file(newPath).delete().catch(() => undefined); // discard the unused render
    if (e instanceof RevocationError) return { ok: false, code: e.code, message: e.message };
    console.error('retag commit error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not save the change.' };
  }

  // The document now points at the new image; the old file is garbage.
  await bucket.file(oldPath).delete().catch(() => undefined);

  await firestore.collection('auditLogs').add({
    action: 'INVITATION_TAG_CHANGED',
    actor: admin.uid,
    actorType: 'admin',
    detail: { invitationId, serialNumber: serial, from: oldTag, to: nextTag, reason },
    at: FieldValue.serverTimestamp(),
  });

  const [imageUrl] = await bucket.file(newPath).getSignedUrl({ action: 'read', expires: Date.now() + 10 * 60 * 1000 });
  return { ok: true, serialNumber: serial, tag: nextTag, printed: newText, changed: true, imageUrl };
}

/**
 * Deletes one or more invitations outright: removes the Firestore record
 * AND its rendered card image from Cloud Storage (the admin console asks
 * the operator to confirm this Storage cascade before calling this — see
 * the invitations page). Non-transactional by design: unlike revoke/rescan
 * there is no in-progress state to protect against a racing scan — once a
 * doc is gone, a concurrent scan simply 404s, which is the correct outcome
 * for something the admin explicitly asked to erase.
 *
 * Each event's totalGenerated/totalUsed/totalRevoked counters are
 * decremented to match, so the dashboard's `unused = generated - used -
 * revoked` math stays correct after the delete.
 */
export async function deleteInvitations(
  firestore: Firestore,
  bucket: Bucket,
  input: { invitationIds: string[]; reason: string; admin: AdminActor }
): Promise<ServiceResult<{ deleted: number; skipped: number }>> {
  const { invitationIds, reason, admin } = input;
  const deletedLog: { id: string; serial: string | null; status: string | null }[] = [];
  const eventDeltas = new Map<string, { generated: number; used: number; revoked: number }>();
  let skipped = 0;

  for (const id of invitationIds) {
    const ref = firestore.collection('invitations').doc(id);
    const snap = await ref.get();
    if (!snap.exists) {
      skipped += 1;
      continue;
    }
    const data = snap.data()!;
    const eventId = data.eventId as string | undefined;
    const status = (data.status as string | undefined) ?? null;
    const storagePath = (data.imageStoragePath as string | undefined) ?? null;

    if (storagePath) {
      await bucket.file(storagePath).delete().catch((e) => {
        // Non-fatal, same rationale as event-level Storage cleanup: an
        // already-gone or unreadable object must never block removing the
        // Firestore record the admin explicitly asked to delete.
        console.error('invitation storage cleanup failed', storagePath, (e as Error).message);
      });
    }
    await ref.delete();

    if (eventId) {
      const delta = eventDeltas.get(eventId) ?? { generated: 0, used: 0, revoked: 0 };
      delta.generated += 1;
      if (status === 'used') delta.used += 1;
      if (status === 'revoked') delta.revoked += 1;
      eventDeltas.set(eventId, delta);
    }
    deletedLog.push({ id, serial: (data.serialNumber as string | undefined) ?? null, status });
  }

  if (deletedLog.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: 'None of the selected invitations were found.' };
  }

  if (eventDeltas.size > 0) {
    const batch = firestore.batch();
    for (const [eventId, delta] of eventDeltas) {
      const update: Record<string, unknown> = { totalGenerated: FieldValue.increment(-delta.generated) };
      if (delta.used) update.totalUsed = FieldValue.increment(-delta.used);
      if (delta.revoked) update.totalRevoked = FieldValue.increment(-delta.revoked);
      batch.update(firestore.collection('events').doc(eventId), update);
    }
    await batch.commit();
  }

  await firestore.collection('auditLogs').add({
    action: 'INVITATION_DELETED',
    actor: admin.uid,
    actorType: 'admin',
    detail: { reason, count: deletedLog.length, skipped, invitations: deletedLog },
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true, deleted: deletedLog.length, skipped };
}

class RevocationError extends Error {
  constructor(public code: 'NOT_FOUND' | 'NOT_UNUSED' | 'NOT_USED' | 'BELOW_USED' | 'REVOKED' | 'ERROR', message: string) {
    super(message);
  }
}

// keep Timestamp import used (usedAt typing helper)
export type UsedAtTimestamp = Timestamp;
