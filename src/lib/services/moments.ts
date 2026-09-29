import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { randomBytes } from 'crypto';
import * as r2 from '@/lib/moments/r2';
import {
  checkFile, planUpload, buildKey, safeDisplayName,
  MAX_FILE_BYTES, MAX_FILES_PER_GUEST, MAX_FILES_PER_BATCH,
} from '@/lib/moments/rules';

/**
 * Guest media ("moments"). Firestore holds the metadata (fast admin grid,
 * counts, guest caps); the bytes live in Cloudflare R2. Nothing here touches
 * Firebase Storage, where the invitation cards are.
 *
 * Lifecycle of one upload:
 *   startUploads  -> creates a 'pending' record + presigned URL(s)
 *   (browser PUTs straight to R2)
 *   completeUpload-> verifies the object in R2 (exists, size <= cap), marks
 *                    it 'ready'. Only 'ready' items are ever shown/exported.
 * A 'pending' record that never completes is harmless: it is never listed,
 * and does not count toward anything except the guest's abuse cap.
 */

export type MomentStatus = 'pending' | 'ready';
export type MomentDoc = {
  eventId: string;
  guestId: string;
  key: string;
  kind: 'photo' | 'video';
  contentType: string;
  originalName: string;
  declaredSize: number;
  size: number | null;
  status: MomentStatus;
  uploadId: string | null;
  createdAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp;
  completedAt: FirebaseFirestore.FieldValue | FirebaseFirestore.Timestamp | null;
};

export type StartFileInput = { name: string; type: string; size: number };
export type StartedUpload =
  | { ok: true; momentId: string; name: string; mode: 'single'; url: string; contentType: string }
  | { ok: true; momentId: string; name: string; mode: 'multipart'; contentType: string; partSize: number; parts: { partNumber: number; url: string }[] }
  | { ok: false; name: string; message: string };

const newId = () => randomBytes(12).toString('base64url');

/** Guest ids are random client-generated strings; accept only a sane shape. */
export function isValidGuestId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(id);
}

export async function resolveEventBySlug(firestore: Firestore, slug: string) {
  const snap = await firestore.collection('events').where('slug', '==', slug).limit(1).get();
  if (snap.empty) return null;
  const d = snap.docs[0];
  const data = d.data();
  // Archived / deleted events do not accept new uploads.
  if (data.lifecycleStatus && data.lifecycleStatus !== 'open') return { id: d.id, name: data.name as string, open: false };
  return { id: d.id, name: data.name as string, open: true };
}

export async function startUploads(
  firestore: Firestore,
  input: { eventId: string; guestId: string; files: StartFileInput[] }
): Promise<{ ok: true; uploads: StartedUpload[] } | { ok: false; message: string }> {
  const { eventId, guestId, files } = input;
  if (!files.length) return { ok: false, message: 'Choose at least one photo or video.' };
  if (files.length > MAX_FILES_PER_BATCH) {
    return { ok: false, message: `Please upload up to ${MAX_FILES_PER_BATCH} files at a time.` };
  }

  // Per-guest cap (cost protection). Counts pending + ready so a client can't
  // dodge the cap by never completing uploads.
  const existing = await firestore
    .collection('moments').where('eventId', '==', eventId).where('guestId', '==', guestId).count().get();
  const already = existing.data().count;
  let room = Math.max(MAX_FILES_PER_GUEST - already, 0);
  if (room === 0) return { ok: false, message: `You have reached the limit of ${MAX_FILES_PER_GUEST} uploads.` };

  const uploads: StartedUpload[] = [];
  for (const f of files) {
    const check = checkFile(f);
    if (!check.ok) { uploads.push({ ok: false, name: f.name, message: check.message }); continue; }
    if (room === 0) { uploads.push({ ok: false, name: f.name, message: `Upload limit of ${MAX_FILES_PER_GUEST} reached.` }); continue; }
    room--;

    const momentId = newId();
    const key = buildKey(eventId, momentId, check.ext);
    const plan = planUpload(f.size);
    const ref = firestore.collection('moments').doc(momentId);

    try {
      if (plan.mode === 'single') {
        const url = await r2.presignPut(key, check.contentType);
        await ref.set(baseDoc({ eventId, guestId, key, check, f, uploadId: null }));
        uploads.push({ ok: true, momentId, name: f.name, mode: 'single', url, contentType: check.contentType });
      } else {
        const uploadId = await r2.createMultipart(key, check.contentType);
        const parts = await Promise.all(
          Array.from({ length: plan.parts }, async (_, i) => ({ partNumber: i + 1, url: await r2.presignPart(key, uploadId, i + 1) }))
        );
        await ref.set(baseDoc({ eventId, guestId, key, check, f, uploadId }));
        uploads.push({ ok: true, momentId, name: f.name, mode: 'multipart', contentType: check.contentType, partSize: plan.partSize, parts });
      }
    } catch (e) {
      console.error('moments start error', (e as Error).message);
      uploads.push({ ok: false, name: f.name, message: 'Could not start this upload. Please try again.' });
    }
  }
  return { ok: true, uploads };
}

function baseDoc(a: {
  eventId: string; guestId: string; key: string; f: StartFileInput; uploadId: string | null;
  check: { kind: 'photo' | 'video'; contentType: string; ext: string };
}): MomentDoc {
  return {
    eventId: a.eventId, guestId: a.guestId, key: a.key,
    kind: a.check.kind, contentType: a.check.contentType,
    originalName: safeDisplayName(a.f.name, a.check.ext),
    declaredSize: a.f.size, size: null, status: 'pending', uploadId: a.uploadId,
    createdAt: FieldValue.serverTimestamp(), completedAt: null,
  };
}

export type CompleteResult =
  | { ok: true; momentId: string; kind: 'photo' | 'video'; previewUrl: string }
  | { ok: false; code: 'NOT_FOUND' | 'MISSING' | 'TOO_LARGE' | 'ERROR'; message: string };

/**
 * Finishes an upload. Verifies against R2 itself (not the client's word) that
 * the object exists and is within the size cap; an oversize object is deleted
 * on the spot so a tampered client can't park large files in the bucket.
 */
export async function completeUpload(
  firestore: Firestore,
  input: { momentId: string; guestId: string; eventId: string; parts?: { PartNumber: number; ETag: string }[] }
): Promise<CompleteResult> {
  const ref = firestore.collection('moments').doc(input.momentId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Upload not found.' };
  const m = snap.data() as MomentDoc;
  // A guest can only complete their OWN upload for THIS event.
  if (m.guestId !== input.guestId || m.eventId !== input.eventId) return { ok: false, code: 'NOT_FOUND', message: 'Upload not found.' };

  try {
    if (m.status === 'ready') {
      return { ok: true, momentId: snap.id, kind: m.kind, previewUrl: await r2.presignGet(m.key, { contentType: m.contentType }) };
    }
    if (m.uploadId) {
      if (!input.parts?.length) return { ok: false, code: 'MISSING', message: 'Upload was incomplete.' };
      await r2.completeMultipart(m.key, m.uploadId, input.parts);
    }
    const head = await r2.headObject(m.key);
    if (!head) return { ok: false, code: 'MISSING', message: 'The file did not finish uploading.' };
    if (head.size > MAX_FILE_BYTES) {
      await r2.deleteObject(m.key).catch(() => undefined);
      await ref.delete();
      return { ok: false, code: 'TOO_LARGE', message: `That file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
    }
    await ref.update({ status: 'ready', size: head.size, completedAt: FieldValue.serverTimestamp(), uploadId: null });
    return { ok: true, momentId: snap.id, kind: m.kind, previewUrl: await r2.presignGet(m.key, { contentType: m.contentType }) };
  } catch (e) {
    console.error('moments complete error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not finish this upload.' };
  }
}

export async function abortUpload(firestore: Firestore, input: { momentId: string; guestId: string; eventId: string }) {
  const ref = firestore.collection('moments').doc(input.momentId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const m = snap.data() as MomentDoc;
  if (m.guestId !== input.guestId || m.eventId !== input.eventId || m.status !== 'pending') return;
  if (m.uploadId) await r2.abortMultipart(m.key, m.uploadId);
  else await r2.deleteObject(m.key).catch(() => undefined);
  await ref.delete();
}

// ---------------------------------------------------------------- admin ----

export type MomentDTO = {
  id: string; kind: 'photo' | 'video'; name: string; size: number; contentType: string; createdAt: string | null; guestId: string;
};

export async function listMoments(
  firestore: Firestore,
  input: { eventId: string; limit: number; after?: string | null }
): Promise<{ items: MomentDTO[]; nextCursor: string | null; total: number }> {
  const base = firestore.collection('moments').where('eventId', '==', input.eventId).where('status', '==', 'ready');
  const total = (await base.count().get()).data().count;
  let q = base.orderBy('completedAt', 'desc').limit(input.limit + 1);
  if (input.after) {
    const cur = await firestore.collection('moments').doc(input.after).get();
    if (cur.exists) q = q.startAfter(cur);
  }
  const snap = await q.get();
  const docs = snap.docs.slice(0, input.limit);
  const items = docs.map((d) => {
    const m = d.data() as Omit<MomentDoc, 'createdAt' | 'completedAt'> & { completedAt?: FirebaseFirestore.Timestamp };
    return {
      id: d.id, kind: m.kind, name: m.originalName, size: m.size ?? 0, contentType: m.contentType,
      createdAt: m.completedAt?.toDate?.().toISOString() ?? null, guestId: m.guestId,
    };
  });
  return { items, nextCursor: snap.docs.length > input.limit ? docs[docs.length - 1].id : null, total };
}

export async function getMomentsByIds(firestore: Firestore, eventId: string, ids: string[]) {
  const out: { id: string; key: string; name: string; kind: 'photo' | 'video'; contentType: string }[] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snaps = await firestore.getAll(...chunk.map((id) => firestore.collection('moments').doc(id)));
    for (const s of snaps) {
      if (!s.exists) continue;
      const m = s.data() as MomentDoc;
      if (m.eventId !== eventId || m.status !== 'ready') continue; // never leak another event's media
      out.push({ id: s.id, key: m.key, name: m.originalName, kind: m.kind, contentType: m.contentType });
    }
  }
  return out;
}

export async function getAllReadyMoments(firestore: Firestore, eventId: string) {
  const out: { id: string; key: string; name: string; kind: 'photo' | 'video'; contentType: string }[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = firestore.collection('moments').where('eventId', '==', eventId).where('status', '==', 'ready').orderBy('completedAt', 'asc').limit(500);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const d of snap.docs) {
      const m = d.data() as MomentDoc;
      out.push({ id: d.id, key: m.key, name: m.originalName, kind: m.kind, contentType: m.contentType });
    }
    if (snap.docs.length < 500) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return out;
}

export async function deleteMoments(firestore: Firestore, eventId: string, ids: string[]): Promise<number> {
  const items = await getMomentsByIds(firestore, eventId, ids);
  for (const it of items) {
    await r2.deleteObject(it.key).catch(() => undefined);
    await firestore.collection('moments').doc(it.id).delete();
  }
  return items.length;
}
