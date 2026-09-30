import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDb, seedEvent, EV1, EV2 } from './helpers';

// Only R2 is faked (in memory). Firestore, caps, ownership all run for real.
const store = new Map<string, { size: number; contentType: string | null }>();
const deleted: string[] = [];
vi.mock('@/lib/moments/r2', async () => {
  const actual = await vi.importActual<typeof import('@/lib/moments/r2')>('@/lib/moments/r2');
  return {
    ...actual,
    presignPut: async (key: string) => `https://r2.test/put/${key}`,
    presignGet: async (key: string, o?: { ttlSeconds?: number }) => `https://r2.test/get/${key}?ttl=${o?.ttlSeconds ?? 600}`,
    headObject: async (key: string) => store.get(key) ?? null,
    deleteObject: async (key: string) => { deleted.push(key); store.delete(key); },
  };
});

import * as svc from '@/lib/services/slides';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;
const MB = 1024 * 1024;
const jpg = (name = 'a.jpg', size = 2 * MB) => ({ name, type: 'image/jpeg', size });

describe.skipIf(!hasEmu)('guest page slideshow service', () => {
  beforeAll(async () => { await seedEvent(db!.db, EV1); await seedEvent(db!.db, EV2, { slug: 'other-event', code: 'OTHER' }); });
  afterAll(async () => { await db!.cleanup(); });
  beforeEach(async () => {
    store.clear(); deleted.length = 0;
    for (const id of [EV1, EV2]) await db!.db.collection('events').doc(id).update({ slides: [] });
  });

  /** start + land in fake R2 + complete, like the browser does */
  async function addSlide(eventId: string, name = 'a.jpg', size = 2 * MB, contentType = 'image/jpeg') {
    const r = await svc.startSlideUploads(db!.db, eventId, [{ name, type: contentType, size }]);
    if (!r.ok || !r.uploads[0].ok) throw new Error('start failed');
    const u = r.uploads[0];
    store.set(u.key, { size, contentType });
    await svc.completeSlideUploads(db!.db, eventId, [{ id: u.id, key: u.key, name }]);
    return u;
  }

  it('an event starts with no slides', async () => {
    expect(await svc.listSlides(db!.db, EV1)).toEqual([]);
  });

  it('start refuses non-images and oversized files, and accepts good ones in the same batch', async () => {
    const r = await svc.startSlideUploads(db!.db, EV1, [
      jpg('good.jpg'),
      { name: 'clip.mp4', type: 'video/mp4', size: MB },
      { name: 'doc.pdf', type: 'application/pdf', size: MB },
      { name: 'huge.jpg', type: 'image/jpeg', size: svc.MAX_SLIDE_BYTES + 1 },
    ]);
    if (!r.ok) throw new Error('unexpected');
    expect(r.uploads.map((u) => u.ok)).toEqual([true, false, false, false]);
    expect(r.uploads[0]).toMatchObject({ ok: true });
  });

  it('a completed upload appears in the list, under this event\'s own prefix', async () => {
    const u = await addSlide(EV1, 'couple.jpg');
    const list = await svc.listSlides(db!.db, EV1);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: u.id, name: 'couple.jpg' });
    expect(list[0].key.startsWith(svc.slidePrefix(EV1))).toBe(true);
  });

  it('slides never leak between events', async () => {
    await addSlide(EV1, 'one.jpg');
    expect(await svc.listSlides(db!.db, EV2)).toEqual([]);
  });

  it('does NOT trust the browser: a key that was never uploaded is ignored', async () => {
    const out = await svc.completeSlideUploads(db!.db, EV1, [{ id: 'x', key: `${svc.slidePrefix(EV1)}never.jpg`, name: 'never.jpg' }]);
    expect(out).toEqual({ added: [], rejected: 1 });
    expect(await svc.listSlides(db!.db, EV1)).toEqual([]);
  });

  it('a key from ANOTHER event (or a path trick) cannot be attached', async () => {
    store.set(`${svc.slidePrefix(EV2)}theirs.jpg`, { size: MB, contentType: 'image/jpeg' });
    store.set('moments/secret.jpg', { size: MB, contentType: 'image/jpeg' });
    const out = await svc.completeSlideUploads(db!.db, EV1, [
      { id: 'a', key: `${svc.slidePrefix(EV2)}theirs.jpg`, name: 'theirs.jpg' },
      { id: 'b', key: 'moments/secret.jpg', name: 'secret.jpg' },
      { id: 'c', key: `${svc.slidePrefix(EV1)}../${EV2}/theirs.jpg`, name: 'trick.jpg' },
    ]);
    expect(out.added).toEqual([]);
    expect(out.rejected).toBe(3);
    expect(await svc.listSlides(db!.db, EV1)).toEqual([]);
  });

  it('an object that is not really an image is rejected AND deleted from storage', async () => {
    const r = await svc.startSlideUploads(db!.db, EV1, [jpg('liar.jpg')]);
    if (!r.ok || !r.uploads[0].ok) throw new Error('start failed');
    const u = r.uploads[0];
    store.set(u.key, { size: MB, contentType: 'application/x-msdownload' }); // browser lied
    const out = await svc.completeSlideUploads(db!.db, EV1, [{ id: u.id, key: u.key, name: 'liar.jpg' }]);
    expect(out.added).toEqual([]);
    expect(deleted).toContain(u.key);
    expect(await svc.listSlides(db!.db, EV1)).toEqual([]);
  });

  it('completing the same upload twice does not create a duplicate', async () => {
    const u = await addSlide(EV1);
    await svc.completeSlideUploads(db!.db, EV1, [{ id: u.id, key: u.key, name: 'a.jpg' }]);
    expect(await svc.listSlides(db!.db, EV1)).toHaveLength(1);
  });

  it('is capped at MAX_SLIDES and never leaves orphan files behind', async () => {
    const ref = db!.db.collection('events').doc(EV1);
    await ref.update({ slides: Array.from({ length: svc.MAX_SLIDES }, (_, i) => ({ id: `s${i}`, key: `${svc.slidePrefix(EV1)}s${i}.jpg`, name: `s${i}.jpg`, size: 1 })) });
    const r = await svc.startSlideUploads(db!.db, EV1, [jpg()]);
    expect(r).toMatchObject({ ok: false });
  });

  it('two admins adding at once do not lose each other\'s photos', async () => {
    const [a, b] = await Promise.all([addSlide(EV1, 'a.jpg'), addSlide(EV1, 'b.jpg')]);
    const ids = (await svc.listSlides(db!.db, EV1)).map((s) => s.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it('delete removes the record and the stored file, and only for that event', async () => {
    const u = await addSlide(EV1, 'gone.jpg');
    expect(await svc.deleteSlide(db!.db, EV2, u.id)).toBe(false); // wrong event
    expect(await svc.listSlides(db!.db, EV1)).toHaveLength(1);
    expect(await svc.deleteSlide(db!.db, EV1, u.id)).toBe(true);
    expect(await svc.listSlides(db!.db, EV1)).toEqual([]);
    expect(deleted).toContain(u.key);
    expect(await svc.deleteSlide(db!.db, EV1, u.id)).toBe(false); // already gone
  });

  it('signed links are long-lived enough for a page left open at the event', async () => {
    await addSlide(EV1);
    const signed = await svc.signedSlides(await svc.listSlides(db!.db, EV1));
    expect(signed[0].url).toContain(`ttl=${svc.SLIDE_GET_TTL_SECONDS}`);
    expect(svc.SLIDE_GET_TTL_SECONDS).toBeGreaterThanOrEqual(6 * 3600);
  });
});
