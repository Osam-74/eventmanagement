import type { Firestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';
import { presignPut, presignGet, headObject, deleteObject } from '@/lib/moments/r2';

/**
 * Background slideshow for the public guest upload page.
 *
 * The photos live in the same private R2 bucket as guest moments but under a
 * separate prefix (`slides/<eventId>/`), so they never show up in the moments
 * folders, counts or zip exports. Metadata is a small array on the event doc
 * (no new collection, no new index). The bucket stays private: the public page
 * only ever gets short-lived signed URLs.
 */
export const MAX_SLIDES = 60;
export const MAX_SLIDE_BYTES = 12 * 1024 * 1024; // a background image, not a raw camera file
export const SLIDE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const SLIDE_GET_TTL_SECONDS = 60 * 60 * 6; // signed links stay valid across a long event page visit

export type Slide = { id: string; key: string; name: string; size: number };

export const slidePrefix = (eventId: string) => `slides/${eventId}/`;
const isSlideKeyFor = (eventId: string, key: string) => key.startsWith(slidePrefix(eventId)) && !key.includes('..');

function readSlides(data: FirebaseFirestore.DocumentData | undefined): Slide[] {
  const raw = data?.slides;
  return Array.isArray(raw) ? (raw as Slide[]).filter((s) => s && typeof s.key === 'string') : [];
}

export async function listSlides(firestore: Firestore, eventId: string): Promise<Slide[]> {
  const d = await firestore.collection('events').doc(eventId).get();
  return d.exists ? readSlides(d.data()) : [];
}

/** Step 1: hand back one short-lived upload URL per accepted file. Nothing is saved yet. */
export async function startSlideUploads(
  firestore: Firestore,
  eventId: string,
  files: { name: string; type: string; size: number }[]
): Promise<{ ok: true; uploads: ({ ok: true; id: string; key: string; url: string; contentType: string } | { ok: false; message: string })[] } | { ok: false; message: string }> {
  const current = await listSlides(firestore, eventId);
  let room = MAX_SLIDES - current.length;
  if (room <= 0) return { ok: false, message: `You can have up to ${MAX_SLIDES} slideshow photos. Remove some first.` };
  const uploads = [];
  for (const f of files) {
    if (!(SLIDE_TYPES as readonly string[]).includes(f.type)) { uploads.push({ ok: false as const, message: `${f.name}: use a JPG, PNG or WebP photo.` }); continue; }
    if (f.size > MAX_SLIDE_BYTES) { uploads.push({ ok: false as const, message: `${f.name} is over 12 MB. Export a smaller copy.` }); continue; }
    if (room <= 0) { uploads.push({ ok: false as const, message: `Limit of ${MAX_SLIDES} photos reached.` }); continue; }
    room--;
    const id = randomBytes(9).toString('base64url');
    const key = `${slidePrefix(eventId)}${id}.${EXT[f.type]}`;
    uploads.push({ ok: true as const, id, key, url: await presignPut(key, f.type), contentType: f.type });
  }
  return { ok: true, uploads };
}

/**
 * Step 2: the browser says it finished. We do NOT trust that: each object must
 * really exist under this event's prefix with an image type, or it is ignored.
 * Runs in a transaction so two admins adding at once cannot lose each other's photos.
 */
export async function completeSlideUploads(
  firestore: Firestore,
  eventId: string,
  items: { id: string; key: string; name: string }[]
): Promise<{ added: Slide[]; rejected: number }> {
  const verified: Slide[] = [];
  let rejected = 0;
  for (const it of items) {
    if (!isSlideKeyFor(eventId, it.key)) { rejected++; continue; }
    const head = await headObject(it.key);
    if (!head || !head.contentType || !head.contentType.startsWith('image/') || head.size > MAX_SLIDE_BYTES) {
      rejected++; if (head) await deleteObject(it.key).catch(() => undefined); continue;
    }
    verified.push({ id: it.id, key: it.key, name: it.name.slice(0, 120), size: head.size });
  }
  const ref = firestore.collection('events').doc(eventId);
  let added: Slide[] = [];
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = readSlides(snap.data());
    const have = new Set(cur.map((s) => s.key));
    added = verified.filter((s) => !have.has(s.key)).slice(0, Math.max(MAX_SLIDES - cur.length, 0));
    if (added.length) tx.update(ref, { slides: [...cur, ...added] });
  });
  // anything verified but not kept (over the cap) must not linger in storage
  for (const s of verified) if (!added.some((a) => a.key === s.key) && !(await listSlides(firestore, eventId)).some((c) => c.key === s.key)) await deleteObject(s.key).catch(() => undefined);
  return { added, rejected };
}

export async function deleteSlide(firestore: Firestore, eventId: string, slideId: string): Promise<boolean> {
  const ref = firestore.collection('events').doc(eventId);
  let key: string | null = null;
  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = readSlides(snap.data());
    const hit = cur.find((s) => s.id === slideId);
    if (!hit) return;
    key = hit.key;
    tx.update(ref, { slides: cur.filter((s) => s.id !== slideId) });
  });
  if (key && isSlideKeyFor(eventId, key)) await deleteObject(key).catch(() => undefined);
  return key !== null;
}

/** Signed, short-lived image URLs for the admin grid or the public page. */
export async function signedSlides(slides: Slide[]): Promise<{ id: string; name: string; url: string }[]> {
  return Promise.all(slides.map(async (s) => ({ id: s.id, name: s.name, url: await presignGet(s.key, { ttlSeconds: SLIDE_GET_TTL_SECONDS }) })));
}
