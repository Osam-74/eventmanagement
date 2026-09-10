import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import type { bucket as bucketFn } from '@/lib/firebase/admin';

type Bucket = ReturnType<typeof bucketFn>;

export type LifecycleResult<T = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; code: 'NOT_FOUND' | 'NOT_ARCHIVED' | 'ALREADY_ARCHIVED' | 'CONFIRM_MISMATCH' | 'ERROR'; message: string };

/**
 * Delete = archive (soft delete). The event doc is kept — nothing generated
 * for it is destroyed — but it is stamped `deleted: true` and dropped out of
 * every list/selector an admin uses (see the `?archived=` filter on
 * GET /api/admin/events). Its cards stop being usable immediately: scanning
 * and generation both re-check `deleted` server-side (scan.ts, generate
 * route), and scanning is force-disabled here too, belt-and-suspenders.
 */
export async function archiveEvent(
  firestore: Firestore,
  input: { eventId: string; actorUid: string }
): Promise<LifecycleResult> {
  const ref = firestore.collection('events').doc(input.eventId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Event not found' };
  if (snap.data()?.deleted === true) return { ok: false, code: 'ALREADY_ARCHIVED', message: 'Event is already archived' };

  await ref.update({
    deleted: true,
    deletedAt: FieldValue.serverTimestamp(),
    deletedBy: input.actorUid,
    scanningEnabled: false,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await firestore.collection('auditLogs').add({
    action: 'EVENT_ARCHIVED',
    actor: input.actorUid,
    actorType: 'admin',
    detail: { eventId: input.eventId },
    at: FieldValue.serverTimestamp(),
  });
  return { ok: true };
}

/** Restore: undoes archiveEvent. Scanning stays off — an admin must re-activate it explicitly. */
export async function restoreEvent(
  firestore: Firestore,
  input: { eventId: string; actorUid: string }
): Promise<LifecycleResult> {
  const ref = firestore.collection('events').doc(input.eventId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Event not found' };
  if (snap.data()?.deleted !== true) return { ok: false, code: 'NOT_ARCHIVED', message: 'Event is not archived' };

  await ref.update({
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await firestore.collection('auditLogs').add({
    action: 'EVENT_RESTORED',
    actor: input.actorUid,
    actorType: 'admin',
    detail: { eventId: input.eventId },
    at: FieldValue.serverTimestamp(),
  });
  return { ok: true };
}

/** Firestore batched-delete limit is 500 writes; stay comfortably under it. */
const DELETE_CHUNK = 400;

async function deleteCollectionByEventId(firestore: Firestore, collection: string, eventId: string): Promise<number> {
  let total = 0;
  // Re-query after each chunk instead of paging with a cursor — documents
  // already deleted simply drop out of the next page, so this terminates
  // even under concurrent writes and needs no composite index.
  for (;;) {
    const snap = await firestore.collection(collection).where('eventId', '==', eventId).limit(DELETE_CHUNK).get();
    if (snap.empty) break;
    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < DELETE_CHUNK) break;
  }
  return total;
}

/**
 * Releases an usher's PIN index the same way `setUsherActive(false)` does —
 * only if the registry entry still points at THIS usher (it may have been
 * reassigned, or already released), mirroring the ownership check in
 * usherAuth.ts so a permanent delete can never steal another usher's PIN.
 */
async function deleteUshersForEvent(firestore: Firestore, eventId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await firestore.collection('ushers').where('eventId', '==', eventId).limit(DELETE_CHUNK).get();
    if (snap.empty) break;
    const batch = firestore.batch();
    for (const d of snap.docs) {
      const idx = d.data().pinIndex as string | undefined;
      if (idx) {
        const reg = await firestore.collection('pinRegistry').doc(idx).get();
        if (reg.exists && reg.data()?.usherId === d.id) batch.delete(reg.ref);
      }
      batch.delete(d.ref);
    }
    await batch.commit();
    total += snap.size;
    if (snap.size < DELETE_CHUNK) break;
  }
  return total;
}

async function deleteStorageForEvent(bucket: Bucket, eventId: string): Promise<void> {
  await bucket.deleteFiles({ prefix: `events/${eventId}/` }).catch((e) => {
    // Non-fatal: an orphaned image under a deleted event's prefix costs
    // storage, not correctness — the Firestore records are gone either way.
    console.error('event storage cleanup failed', (e as Error).message);
  });
}

export type PermanentDeleteCounts = {
  invitations: number;
  batches: number;
  ushers: number;
  scanLogs: number;
};

/**
 * Irreversible. Only allowed once an event is already archived (`deleted:
 * true`) — an extra guard against deleting a live event by mistake — and
 * only when the caller's typed confirmation matches the event's slug
 * exactly. Cascades through every collection keyed by eventId plus the
 * event's Storage prefix, then removes the event doc itself.
 */
export async function permanentlyDeleteEvent(
  firestore: Firestore,
  bucket: Bucket,
  input: { eventId: string; confirmSlug: string; actorUid: string }
): Promise<LifecycleResult<{ counts: PermanentDeleteCounts }>> {
  const ref = firestore.collection('events').doc(input.eventId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Event not found' };
  const event = snap.data()!;
  if (event.deleted !== true) {
    return { ok: false, code: 'NOT_ARCHIVED', message: 'Archive the event first before deleting it permanently.' };
  }
  if (input.confirmSlug !== event.slug) {
    return { ok: false, code: 'CONFIRM_MISMATCH', message: 'Typed confirmation does not match this event\u2019s slug.' };
  }

  const [invitations, batches, ushers, scanLogs] = [
    await deleteCollectionByEventId(firestore, 'invitations', input.eventId),
    await deleteCollectionByEventId(firestore, 'batches', input.eventId),
    await deleteUshersForEvent(firestore, input.eventId),
    await deleteCollectionByEventId(firestore, 'scanLogs', input.eventId),
  ];
  await deleteStorageForEvent(bucket, input.eventId);
  await ref.delete();

  const counts: PermanentDeleteCounts = { invitations, batches, ushers, scanLogs };
  await firestore.collection('auditLogs').add({
    action: 'EVENT_PERMANENTLY_DELETED',
    actor: input.actorUid,
    actorType: 'admin',
    detail: { eventId: input.eventId, slug: event.slug, name: event.name, counts },
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true, counts };
}
