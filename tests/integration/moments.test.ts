import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { makeDb, seedEvent, EV1, EV2 } from './helpers';

const firestoreDelete = () => FieldValue.delete();

// R2 is an external service: replace ONLY it with an in-memory fake. Every
// other layer (Firestore, caps, ownership, scoping) runs for real.
const store = new Map<string, { size: number }>();
const multipart = new Map<string, string>();
const calls = { deleted: [] as string[], aborted: [] as string[] };
vi.mock('@/lib/moments/r2', async () => {
  const actual = await vi.importActual<typeof import('@/lib/moments/r2')>('@/lib/moments/r2');
  return {
    ...actual,
    presignPut: async (key: string) => `https://r2.test/put/${key}`,
    presignGet: async (key: string) => `https://r2.test/get/${key}`,
    presignPart: async (key: string, _u: string, n: number) => `https://r2.test/part/${n}/${key}`,
    createMultipart: async (key: string) => { const id = `mp-${key}`; multipart.set(id, key); return id; },
    completeMultipart: async (key: string, id: string) => { if (!multipart.has(id)) throw new Error('no such upload'); if (!store.has(key)) store.set(key, { size: 50 * 1024 * 1024 }); },
    abortMultipart: async (_k: string, id: string) => { calls.aborted.push(id); multipart.delete(id); },
    headObject: async (key: string) => { const o = store.get(key); return o ? { size: o.size, contentType: null } : null; },
    deleteObject: async (key: string) => { calls.deleted.push(key); store.delete(key); },
  };
});

import * as svc from '@/lib/services/moments';
import { MAX_FILES_PER_GUEST } from '@/lib/moments/rules';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;
const MB = 1024 * 1024;
const G1 = 'guestone-aaaaaaaaaa1';
const G2 = 'guesttwo-bbbbbbbbbb2';

describe.skipIf(!hasEmu)('guest moments service', () => {
  beforeAll(async () => { await seedEvent(db!.db, EV1); await seedEvent(db!.db, EV2, { slug: 'other-event', code: 'OTHER' }); });
  afterAll(async () => { await db!.cleanup(); });
  beforeEach(async () => {
    store.clear(); multipart.clear(); calls.deleted.length = 0; calls.aborted.length = 0;
    const snap = await db!.db.collection('moments').get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  });

  const start = (eventId: string, guestId: string, files: { name: string; type: string; size: number }[]) =>
    svc.startUploads(db!.db, { eventId, guestId, files });
  /** Simulates the browser finishing its PUT to R2. */
  const land = (key: string, size: number) => store.set(key, { size });

  async function uploadReady(eventId: string, guestId: string, name = 'a.jpg', size = 2 * MB) {
    const r = await start(eventId, guestId, [{ name, type: 'image/jpeg', size }]);
    if (!r.ok || !r.uploads[0].ok) throw new Error('start failed');
    const u = r.uploads[0];
    const doc = (await db!.db.collection('moments').doc(u.momentId).get()).data()!;
    land(doc.key, size);
    const c = await svc.completeUpload(db!.db, { momentId: u.momentId, guestId, eventId });
    if (!c.ok) throw new Error('complete failed: ' + c.message);
    return u.momentId;
  }

  it('resolves an event by slug and reports closed events as not open', async () => {
    expect(await svc.resolveEventBySlug(db!.db, 'is-wedding-2026')).toMatchObject({ id: EV1, open: true });
    expect(await svc.resolveEventBySlug(db!.db, 'nope')).toBeNull();
    await db!.db.collection('events').doc(EV2).update({ lifecycleStatus: 'archived' });
    expect(await svc.resolveEventBySlug(db!.db, 'other-event')).toMatchObject({ open: false });
    await db!.db.collection('events').doc(EV2).update({ lifecycleStatus: 'open' });
  });

  it('guest link switch: live by default, off when deactivated, back on when re-activated', async () => {
    const ref = db!.db.collection('events').doc(EV2);
    // an event that never had the field (every link made before the switch) stays live
    expect((await ref.get()).data()!.momentsGuestLinkEnabled).toBeUndefined();
    expect(await svc.resolveEventBySlug(db!.db, 'other-event')).toMatchObject({ open: true });

    await ref.update({ momentsGuestLinkEnabled: false });
    expect(await svc.resolveEventBySlug(db!.db, 'other-event')).toMatchObject({ open: false });
    // a deactivated link refuses NEW uploads
    const blocked = await svc.resolveEventBySlug(db!.db, 'other-event');
    expect(blocked && blocked.open).toBe(false);

    await ref.update({ momentsGuestLinkEnabled: true });
    expect(await svc.resolveEventBySlug(db!.db, 'other-event')).toMatchObject({ open: true });

    // archived still wins even when the switch says live
    await ref.update({ lifecycleStatus: 'archived' });
    expect(await svc.resolveEventBySlug(db!.db, 'other-event')).toMatchObject({ open: false });
    await ref.update({ lifecycleStatus: 'open', momentsGuestLinkEnabled: firestoreDelete() });
  });

  it('single upload: pending until R2 really has the object, then ready', async () => {
    const r = await start(EV1, G1, [{ name: 'IMG_1.jpg', type: 'image/jpeg', size: 3 * MB }]);
    expect(r.ok && r.uploads[0]).toMatchObject({ ok: true, mode: 'single' });
    const u = (r as { uploads: Extract<svc.StartedUpload, { ok: true }>[] }).uploads[0];
    const doc = (await db!.db.collection('moments').doc(u.momentId).get()).data()!;
    expect(doc.status).toBe('pending');
    expect(doc.key).toBe(`events/${EV1}/moments/${u.momentId}.jpg`);

    // browser claims it finished but the file never landed => refused, stays pending
    expect(await svc.completeUpload(db!.db, { momentId: u.momentId, guestId: G1, eventId: EV1 })).toMatchObject({ ok: false, code: 'MISSING' });
    expect((await db!.db.collection('moments').doc(u.momentId).get()).data()!.status).toBe('pending');

    land(doc.key, 3 * MB);
    expect(await svc.completeUpload(db!.db, { momentId: u.momentId, guestId: G1, eventId: EV1 })).toMatchObject({ ok: true, kind: 'photo' });
    const done = (await db!.db.collection('moments').doc(u.momentId).get()).data()!;
    expect(done).toMatchObject({ status: 'ready', size: 3 * MB });
  });

  it('completing twice is idempotent', async () => {
    const id = await uploadReady(EV1, G1);
    expect(await svc.completeUpload(db!.db, { momentId: id, guestId: G1, eventId: EV1 })).toMatchObject({ ok: true });
  });

  it('SERVER enforces the size cap on the real stored object: an oversize file is deleted, not kept', async () => {
    const r = await start(EV1, G1, [{ name: 'a.mp4', type: 'video/mp4', size: 90 * MB }]);
    const u = (r as { uploads: Extract<svc.StartedUpload, { ok: true }>[] }).uploads[0];
    const key = (await db!.db.collection('moments').doc(u.momentId).get()).data()!.key;
    land(key, 250 * MB); // a tampered client uploaded far more than it declared
    const c = await svc.completeUpload(db!.db, { momentId: u.momentId, guestId: G1, eventId: EV1, parts: [{ PartNumber: 1, ETag: 'x' }] });
    expect(c).toMatchObject({ ok: false, code: 'TOO_LARGE' });
    expect(calls.deleted).toContain(key);
    expect((await db!.db.collection('moments').doc(u.momentId).get()).exists).toBe(false);
  });

  it('start refuses oversize / non-media declarations without creating anything', async () => {
    const r = await start(EV1, G1, [
      { name: 'big.mp4', type: 'video/mp4', size: 101 * MB },
      { name: 'evil.html', type: 'text/html', size: 100 },
      { name: 'ok.jpg', type: 'image/jpeg', size: MB },
    ]);
    const ups = (r as { uploads: svc.StartedUpload[] }).uploads;
    expect(ups[0].ok).toBe(false); expect(ups[1].ok).toBe(false); expect(ups[2].ok).toBe(true);
    expect((await db!.db.collection('moments').get()).size).toBe(1);
  });

  it('big videos start a multipart upload with enough signed parts', async () => {
    const r = await start(EV1, G1, [{ name: 'wedding.mp4', type: 'video/mp4', size: 100 * MB }]);
    const u = (r as { uploads: Extract<svc.StartedUpload, { ok: true }>[] }).uploads[0];
    expect(u.mode).toBe('multipart');
    if (u.mode === 'multipart') { expect(u.parts.length).toBe(Math.ceil((100 * MB) / u.partSize)); expect(u.parts[0].partNumber).toBe(1); }
    const key = (await db!.db.collection('moments').doc(u.momentId).get()).data()!.key;
    land(key, 100 * MB);
    // multipart completion needs the part list
    expect(await svc.completeUpload(db!.db, { momentId: u.momentId, guestId: G1, eventId: EV1 })).toMatchObject({ ok: false, code: 'MISSING' });
    expect(await svc.completeUpload(db!.db, { momentId: u.momentId, guestId: G1, eventId: EV1, parts: [{ PartNumber: 1, ETag: 'e' }] })).toMatchObject({ ok: true, kind: 'video' });
  });

  it('per-guest cap: a guest cannot exceed the limit, even by never completing uploads', async () => {
    const f = (i: number) => ({ name: `p${i}.jpg`, type: 'image/jpeg', size: MB });
    let made = 0;
    while (made < MAX_FILES_PER_GUEST) { const n = Math.min(20, MAX_FILES_PER_GUEST - made); const r = await start(EV1, G1, Array.from({ length: n }, (_, i) => f(made + i))); expect(r.ok).toBe(true); made += n; }
    expect((await db!.db.collection('moments').where('guestId', '==', G1).get()).size).toBe(MAX_FILES_PER_GUEST);
    expect(await start(EV1, G1, [f(999)])).toMatchObject({ ok: false });
    // a different guest is unaffected
    expect((await start(EV1, G2, [f(1)])).ok).toBe(true);
  });

  it('a partly-full guest gets exactly the remaining room, the rest are refused', async () => {
    const f = (i: number) => ({ name: `p${i}.jpg`, type: 'image/jpeg', size: MB });
    await start(EV1, G1, Array.from({ length: 20 }, (_, i) => f(i)));
    await start(EV1, G1, Array.from({ length: MAX_FILES_PER_GUEST - 22 }, (_, i) => f(i)));
    const r = await start(EV1, G1, Array.from({ length: 5 }, (_, i) => f(i)));
    const ups = (r as { uploads: svc.StartedUpload[] }).uploads;
    expect(ups.filter((u) => u.ok).length).toBe(2);
    expect(ups.filter((u) => !u.ok).length).toBe(3);
  });

  it("a guest cannot complete or abort SOMEONE ELSE's upload, or use another event", async () => {
    const r = await start(EV1, G1, [{ name: 'a.jpg', type: 'image/jpeg', size: MB }]);
    const u = (r as { uploads: Extract<svc.StartedUpload, { ok: true }>[] }).uploads[0];
    land((await db!.db.collection('moments').doc(u.momentId).get()).data()!.key, MB);
    expect(await svc.completeUpload(db!.db, { momentId: u.momentId, guestId: G2, eventId: EV1 })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await svc.completeUpload(db!.db, { momentId: u.momentId, guestId: G1, eventId: EV2 })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    await svc.abortUpload(db!.db, { momentId: u.momentId, guestId: G2, eventId: EV1 });
    expect((await db!.db.collection('moments').doc(u.momentId).get()).exists).toBe(true); // untouched
  });

  it('abort removes a pending upload and its R2 object; it never removes a ready one', async () => {
    const r = await start(EV1, G1, [{ name: 'a.jpg', type: 'image/jpeg', size: MB }]);
    const u = (r as { uploads: Extract<svc.StartedUpload, { ok: true }>[] }).uploads[0];
    await svc.abortUpload(db!.db, { momentId: u.momentId, guestId: G1, eventId: EV1 });
    expect((await db!.db.collection('moments').doc(u.momentId).get()).exists).toBe(false);

    const ready = await uploadReady(EV1, G1);
    await svc.abortUpload(db!.db, { momentId: ready, guestId: G1, eventId: EV1 });
    expect((await db!.db.collection('moments').doc(ready).get()).exists).toBe(true);
  });

  it('admin list shows ONLY ready items for the requested event (never pending, never another event)', async () => {
    const a = await uploadReady(EV1, G1, 'one.jpg');
    await uploadReady(EV1, G2, 'two.jpg');
    await uploadReady(EV2, G1, 'other-event.jpg');
    await start(EV1, G1, [{ name: 'pending.jpg', type: 'image/jpeg', size: MB }]); // never completed

    const list = await svc.listMoments(db!.db, { eventId: EV1, limit: 48 });
    expect(list.total).toBe(2);
    expect(list.items.map((i) => i.name).sort()).toEqual(['one.jpg', 'two.jpg']);
    expect(list.items.some((i) => i.id === a)).toBe(true);
  });

  it('admin list paginates without duplicates or gaps', async () => {
    for (let i = 0; i < 7; i++) await uploadReady(EV1, i % 2 ? G1 : G2, `p${i}.jpg`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof svc.listMoments>> = await svc.listMoments(db!.db, { eventId: EV1, limit: 3, after: cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('export lookups are scoped to the event: another event\'s ids are silently ignored (no leak)', async () => {
    const mine = await uploadReady(EV1, G1, 'mine.jpg');
    const theirs = await uploadReady(EV2, G1, 'theirs.jpg');
    const got = await svc.getMomentsByIds(db!.db, EV1, [mine, theirs, 'does-not-exist-id']);
    expect(got.map((g) => g.id)).toEqual([mine]);
    expect((await svc.getAllReadyMoments(db!.db, EV1)).map((g) => g.id)).toEqual([mine]);
  });

  it('export-all returns everything even beyond one Firestore page (500+)', async () => {
    // Firestore batches hold at most 500 writes and cannot be reused after commit.
    for (let start = 0; start < 620; start += 300) {
      const batch = db!.db.batch();
      for (let i = start; i < Math.min(start + 300, 620); i++) {
        batch.set(db!.db.collection('moments').doc(`bulk${String(i).padStart(4, '0')}xxxx`), {
          eventId: EV1, guestId: G1, key: `events/${EV1}/moments/bulk${i}.jpg`, kind: 'photo', contentType: 'image/jpeg',
          originalName: `b${i}.jpg`, declaredSize: 1, size: 1, status: 'ready', uploadId: null,
          createdAt: new Date(2026, 8, 29, 0, 0, i), completedAt: new Date(2026, 8, 29, 0, 0, i),
        });
      }
      await batch.commit();
    }
    const all = await svc.getAllReadyMoments(db!.db, EV1);
    expect(all.length).toBe(620);
    expect(new Set(all.map((a) => a.id)).size).toBe(620);
  }, 60000);

  it('delete removes the R2 object AND the record, only for this event', async () => {
    const mine = await uploadReady(EV1, G1, 'mine.jpg');
    const theirs = await uploadReady(EV2, G1, 'theirs.jpg');
    const theirKey = (await db!.db.collection('moments').doc(theirs).get()).data()!.key;
    const myKey = (await db!.db.collection('moments').doc(mine).get()).data()!.key;
    expect(await svc.deleteMoments(db!.db, EV1, [mine, theirs])).toBe(1);
    expect(calls.deleted).toContain(myKey);
    expect(calls.deleted).not.toContain(theirKey);
    expect((await db!.db.collection('moments').doc(theirs).get()).exists).toBe(true);
  });

  describe('optional guest name', () => {
    const named = (guestId: string, guestName: string | undefined, files: { name: string; type: string; size: number }[]) =>
      svc.startUploads(db!.db, { eventId: EV1, guestId, guestName, files });
    const docOf = async (r: Awaited<ReturnType<typeof named>>) => {
      const u = (r as { uploads: Extract<svc.StartedUpload, { ok: true }>[] }).uploads[0];
      return (await db!.db.collection('moments').doc(u.momentId).get()).data()!;
    };
    const JPG = [{ name: 'IMG_1.jpg', type: 'image/jpeg', size: 1 * MB }];

    it('stores the name the guest gave on the upload', async () => {
      const d = await docOf(await named('namedguest-aaaaaaaa1', 'Tunde Bello', JPG));
      expect(d.guestName).toBe('Tunde Bello');
    });

    it('an anonymous upload stores no name at all (no empty field, no placeholder)', async () => {
      for (const v of [undefined, '', '   ']) {
        const d = await docOf(await named('anonguest-aaaaaaaaa1', v, JPG));
        expect('guestName' in d).toBe(false);
      }
    });

    it('the SERVER cleans the name, whatever the browser sent', async () => {
      const d = await docOf(await named('hostile-aaaaaaaaaaaa1', '  <b>Tunde</b>\u0000  /Bello\n' + 'x'.repeat(300), JPG));
      expect(d.guestName).not.toMatch(/[<>/\u0000\n]/);
      expect(d.guestName.length).toBeLessThanOrEqual(40);
      expect(d.guestName.startsWith('bTundeb Bello')).toBe(true);
    });

    it('big videos (multipart) carry the name too', async () => {
      const d = await docOf(await named('namedbig-aaaaaaaaa1', 'Aunty Bisi', [{ name: 'dance.mp4', type: 'video/mp4', size: 100 * MB }]));
      expect(d.guestName).toBe('Aunty Bisi');
      expect(d.uploadId).toBeTruthy();
    });

    it('giving a name does not change the per-guest cap or the guest id', async () => {
      const g = 'capnamed-aaaaaaaaaa1';
      const many = Array.from({ length: MAX_FILES_PER_GUEST }, (_, i) => ({ name: `f${i}.jpg`, type: 'image/jpeg', size: 1000 }));
      for (let off = 0; off < many.length; off += 20) await named(g, 'Tunde', many.slice(off, off + 20));
      // same device, different typed name: still the same guest, still capped
      const r = await named(g, 'Someone Else', JPG);
      expect(r).toMatchObject({ ok: false });
    });
  });

  it('guest id validation', () => {
    expect(svc.isValidGuestId('abcdefghijklmnop')).toBe(true);
    for (const bad of ['short', '', null, undefined, 42, 'has space in it here!!', 'a'.repeat(65), '../../etc/passwd/xxxx']) expect(svc.isValidGuestId(bad)).toBe(false);
  });
});
