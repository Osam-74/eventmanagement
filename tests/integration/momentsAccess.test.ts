import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { makeDb, seedEvent, ACTOR, ROOT_ACTOR, EV1, EV2 } from './helpers';
import {
  createAdminAccount, updateAdminAccount, accessibleMomentEvents, grantableMomentEvents, backfillMomentsAccess,
} from '@/lib/services/admins';
import { canAccessMomentsEvent, emptyPermissions, type AdminContext } from '@/lib/api/helpers';
import { listMoments, listGuestFolders, getAllReadyMoments } from '@/lib/services/moments';
import { ALL_PERMISSIONS } from '@/lib/types';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;
const fakeCreate = async (email: string) => `uid-${email.replace(/[^a-z]/g, '')}`;

const ctx = (over: Partial<AdminContext>): AdminContext => ({
  uid: 'u', email: 'a@b.c', displayName: 'A', accountType: 'ADMIN', permissions: {}, momentsEventIds: [], ...over,
});

describe('moments permissions exist and are grantable', () => {
  it('the three moments permissions are part of the permission set', () => {
    for (const p of ['canViewMoments', 'canDeleteMoments', 'canShareMoments']) expect(ALL_PERMISSIONS).toContain(p);
    expect(emptyPermissions().canViewMoments).toBe(false);
  });
});

describe('event-level access (the guard every moments endpoint uses)', () => {
  it('root admin can open any event', () => {
    expect(canAccessMomentsEvent(ctx({ accountType: 'ROOT_ADMIN' }), 'anything')).toBe(true);
  });
  it('a normal admin can open ONLY the events granted to them', () => {
    const a = ctx({ momentsEventIds: [EV1] });
    expect(canAccessMomentsEvent(a, EV1)).toBe(true);
    expect(canAccessMomentsEvent(a, EV2)).toBe(false);
  });
  it('default is NO events (an admin with the permission but no events sees nothing)', () => {
    expect(canAccessMomentsEvent(ctx({ permissions: { canViewMoments: true } }), EV1)).toBe(false);
    expect(accessibleMomentEvents({ accountType: 'ADMIN' })).toEqual([]);
    expect(accessibleMomentEvents({ accountType: 'ROOT_ADMIN' })).toBeNull();
  });
});

describe.skipIf(!hasEmu)('granting event access (anti-escalation)', () => {
  afterAll(async () => { await db!.cleanup(); });

  it('root admin can grant any events; they are stored on the new admin', async () => {
    const r = await createAdminAccount(db!.db, {
      actor: ROOT_ACTOR, email: 'photog@test.local', displayName: 'Photog',
      permissions: { canViewMoments: true }, momentsEventIds: [EV1, EV2, EV1], createAuthUser: fakeCreate,
    });
    expect(r.ok).toBe(true);
    const doc = (await db!.db.collection('users').doc(r.uid!).get()).data()!;
    expect(doc.momentsEventIds).toEqual([EV1, EV2]); // de-duplicated
    expect(doc.permissions.canViewMoments).toBe(true);
    expect(doc.permissions.canDeleteMoments).toBe(false);
  });

  it('a delegate CANNOT grant events they cannot access themselves', async () => {
    const delegate = { ...ACTOR, uid: 'deleg', permissions: { ...emptyPermissions(), canManageAdmins: true, canViewMoments: true }, momentsEventIds: [EV1] };
    const r = await createAdminAccount(db!.db, {
      actor: delegate, email: 'sub2@test.local', displayName: 'Sub', permissions: { canViewMoments: true },
      momentsEventIds: [EV1, EV2, 'secret-event'], createAuthUser: fakeCreate,
    });
    const doc = (await db!.db.collection('users').doc(r.uid!).get()).data()!;
    expect(doc.momentsEventIds).toEqual([EV1]); // EV2 + secret-event dropped
  });

  it('a delegate cannot grant moments permissions they do not hold', async () => {
    const delegate = { ...ACTOR, uid: 'deleg2', permissions: { ...emptyPermissions(), canManageAdmins: true, canViewMoments: true }, momentsEventIds: [EV1] };
    const r = await createAdminAccount(db!.db, {
      actor: delegate, email: 'sub3@test.local', displayName: 'Sub3',
      permissions: { canViewMoments: true, canDeleteMoments: true, canShareMoments: true }, momentsEventIds: [EV1], createAuthUser: fakeCreate,
    });
    const doc = (await db!.db.collection('users').doc(r.uid!).get()).data()!;
    expect(doc.permissions).toMatchObject({ canViewMoments: true, canDeleteMoments: false, canShareMoments: false });
  });

  it('updating replaces the list but a delegate cannot strip events they cannot even see', async () => {
    // target holds EV1 + EV2. Delegate only sees EV1 and sets the list to [] .
    const t = await createAdminAccount(db!.db, {
      actor: ROOT_ACTOR, email: 'target@test.local', displayName: 'Target',
      permissions: { canViewMoments: true }, momentsEventIds: [EV1, EV2], createAuthUser: fakeCreate,
    });
    const delegate = { ...ACTOR, uid: 'deleg3', permissions: { ...emptyPermissions(), canManageAdmins: true }, momentsEventIds: [EV1] };
    const r = await updateAdminAccount(db!.db, { actor: delegate, targetUid: t.uid!, momentsEventIds: [] });
    expect(r.ok).toBe(true);
    const doc = (await db!.db.collection('users').doc(t.uid!).get()).data()!;
    expect(doc.momentsEventIds).toEqual([EV2]); // EV1 removed (delegate could see it); EV2 untouched
  });

  it('root can fully replace the list, and toggling a permission alone leaves events alone', async () => {
    const t = await createAdminAccount(db!.db, {
      actor: ROOT_ACTOR, email: 'target2@test.local', displayName: 'T2',
      permissions: {}, momentsEventIds: [EV1], createAuthUser: fakeCreate,
    });
    await updateAdminAccount(db!.db, { actor: ROOT_ACTOR, targetUid: t.uid!, permissions: { canViewMoments: true } });
    let doc = (await db!.db.collection('users').doc(t.uid!).get()).data()!;
    expect(doc.momentsEventIds).toEqual([EV1]); // untouched by a permission-only PATCH
    await updateAdminAccount(db!.db, { actor: ROOT_ACTOR, targetUid: t.uid!, momentsEventIds: [EV2] });
    doc = (await db!.db.collection('users').doc(t.uid!).get()).data()!;
    expect(doc.momentsEventIds).toEqual([EV2]);
    expect(doc.permissions.canViewMoments).toBe(true); // and vice versa
  });

  it('grantableMomentEvents drops nothing for root and de-duplicates', () => {
    expect(grantableMomentEvents(ROOT_ACTOR, ['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(grantableMomentEvents({ accountType: 'ADMIN', momentsEventIds: ['a'] }, ['a', 'b'])).toEqual(['a']);
    expect(grantableMomentEvents({ accountType: 'ADMIN' }, ['a'])).toEqual([]);
  });
});

describe.skipIf(!hasEmu)('guest folders and per-guest listing', () => {
  const G = (n: number) => `guest-${n}-aaaaaaaaaaaaaaaaaa`;
  let n = 0;
  async function put(eventId: string, guestId: string, kind: 'photo' | 'video', size: number, at: number, status = 'ready') {
    const id = `m${++n}`;
    await db!.db.collection('moments').doc(id).set({
      eventId, guestId, key: `k/${id}`, kind, contentType: kind === 'photo' ? 'image/jpeg' : 'video/mp4',
      originalName: `${id}.${kind === 'photo' ? 'jpg' : 'mp4'}`, declaredSize: size, size, status, uploadId: null,
      createdAt: FieldValue.serverTimestamp(), completedAt: status === 'ready' ? Timestamp.fromMillis(at) : null,
    });
    return id;
  }
  beforeAll(async () => {
    await seedEvent(db!.db, EV1); await seedEvent(db!.db, EV2, { slug: 'other', code: 'OTH' });
    // guest 2 uploads FIRST, guest 1 second, guest 3 last
    await put(EV1, G(2), 'photo', 100, 1000);
    await put(EV1, G(1), 'photo', 200, 2000);
    await put(EV1, G(2), 'video', 5000, 3000);
    await put(EV1, G(3), 'photo', 300, 4000);
    await put(EV1, G(1), 'photo', 400, 5000);
    await put(EV1, G(1), 'photo', 999, 6000, 'pending'); // never completed
    await put(EV2, G(9), 'photo', 1, 1000);               // other event
  });

  it('one folder per guest, numbered by first upload, counts + sizes right', async () => {
    const { folders, total } = await listGuestFolders(db!.db, EV1);
    expect(folders.map((f) => f.label)).toEqual(['Guest 1', 'Guest 2', 'Guest 3']);
    expect(folders.map((f) => f.guestId)).toEqual([G(2), G(1), G(3)]); // Guest 1 = first to upload
    const g2 = folders.find((f) => f.guestId === G(2))!;
    expect(g2).toMatchObject({ count: 2, photos: 1, videos: 1, bytes: 5100 });
    const g1 = folders.find((f) => f.guestId === G(1))!;
    expect(g1.count).toBe(2); // the pending upload is NOT counted
    expect(total).toBe(5);
  });

  it('never leaks another event\'s guests into the folders', async () => {
    const { folders } = await listGuestFolders(db!.db, EV1);
    expect(folders.some((f) => f.guestId === G(9))).toBe(false);
    expect((await listGuestFolders(db!.db, EV2)).folders).toHaveLength(1);
  });

  it('opening a folder lists only that guest\'s READY files, newest first', async () => {
    const r = await listMoments(db!.db, { eventId: EV1, limit: 48, guestId: G(1) });
    expect(r.items.map((i) => i.size)).toEqual([400, 200]);
    expect(r.total).toBe(2);
    expect(r.items.every((i) => i.guestId === G(1))).toBe(true);
  });

  it('a guest id from ANOTHER event returns nothing (no cross-event peeking)', async () => {
    const r = await listMoments(db!.db, { eventId: EV1, limit: 48, guestId: G(9) });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('folder paging is stable: pages join up with no gaps or repeats', async () => {
    const p1 = await listMoments(db!.db, { eventId: EV1, limit: 1, guestId: G(1) });
    expect(p1.items).toHaveLength(1);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listMoments(db!.db, { eventId: EV1, limit: 1, after: p1.nextCursor, guestId: G(1) });
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0].id).not.toBe(p1.items[0].id);
    expect(p2.nextCursor).toBeNull();
  });

  it('"Export folder" gets ONLY that guest\'s files; without a guest it gets the whole event', async () => {
    const one = await getAllReadyMoments(db!.db, EV1, G(1));
    expect(one).toHaveLength(2);
    const ids = new Set((await listMoments(db!.db, { eventId: EV1, limit: 48, guestId: G(1) })).items.map((i) => i.id));
    expect(one.every((x) => ids.has(x.id))).toBe(true);
    expect(await getAllReadyMoments(db!.db, EV1)).toHaveLength(5);
    expect(await getAllReadyMoments(db!.db, EV1, G(9))).toHaveLength(0); // other event's guest
  });

  it('the event-wide (non-folder) listing is unchanged', async () => {
    const r = await listMoments(db!.db, { eventId: EV1, limit: 48 });
    expect(r.total).toBe(5);
    expect(r.items).toHaveLength(5);
  });
});

describe.skipIf(!hasEmu)('backfill: existing admins keep Guest moments access', () => {
  const bdb = hasEmu ? makeDb() : null;
  afterAll(async () => { await bdb!.cleanup(); });
  const user = (id: string, accountType: string, permissions: Record<string, boolean>, extra: Record<string, unknown> = {}) =>
    bdb!.db.collection('users').doc(id).set({ email: `${id}@t.l`, displayName: id, accountType, active: true, permissions, ...extra });

  beforeAll(async () => {
    await seedEvent(bdb!.db, EV1); await seedEvent(bdb!.db, EV2, { slug: 'two', code: 'TWO' });
    await seedEvent(bdb!.db, 'archived', { slug: 'old', code: 'OLD', deleted: true });
    await user('inviter', 'ADMIN', { canManageInvites: true });
    await user('scanner-only', 'ADMIN', { canManageUshers: true });
    await user('chosen', 'ADMIN', { canManageInvites: true, canViewMoments: true }, { momentsEventIds: [EV2] }); // owner already decided
    await user('root', 'ROOT_ADMIN', {});
  });

  it('dry run reports who WOULD change and writes nothing', async () => {
    const r = await backfillMomentsAccess(bdb!.db, { dryRun: true });
    expect(r.updated).toEqual(['inviter']);
    expect((await bdb!.db.collection('users').doc('inviter').get()).data()!.permissions.canViewMoments).toBeUndefined();
  });

  it('apply: an admin who used moments via canManageInvites keeps it, on every live event (not archived ones)', async () => {
    await backfillMomentsAccess(bdb!.db, { dryRun: false });
    const d = (await bdb!.db.collection('users').doc('inviter').get()).data()!;
    expect(d.permissions).toMatchObject({ canManageInvites: true, canViewMoments: true, canDeleteMoments: true, canShareMoments: true });
    expect([...d.momentsEventIds].sort()).toEqual([EV1, EV2].sort());
  });

  it('admins without the invite permission, root, and already-decided admins are untouched', async () => {
    const get = async (id: string) => (await bdb!.db.collection('users').doc(id).get()).data()!;
    expect((await get('scanner-only')).permissions.canViewMoments).toBeUndefined();
    expect((await get('root')).permissions.canViewMoments).toBeUndefined();
    expect((await get('chosen')).momentsEventIds).toEqual([EV2]); // NOT widened to all events
  });

  it('re-running never overrides a narrowing the owner made afterwards', async () => {
    await bdb!.db.collection('users').doc('inviter').update({ momentsEventIds: [EV1], 'permissions.canDeleteMoments': false });
    const r = await backfillMomentsAccess(bdb!.db, { dryRun: false });
    expect(r.updated).toEqual([]);
    const d = (await bdb!.db.collection('users').doc('inviter').get()).data()!;
    expect(d.momentsEventIds).toEqual([EV1]);
    expect(d.permissions.canDeleteMoments).toBe(false);
  });
});

describe.skipIf(!hasEmu)('guest names in folders', () => {
  const EVN = 'ev-names-1';
  const G = (n: number) => `named-${n}-aaaaaaaaaaaaaaaaaaa`;
  let n = 0;
  async function put(guestId: string, at: number, guestName?: string, status = 'ready') {
    const id = `nm${++n}`;
    await db!.db.collection('moments').doc(id).set({
      eventId: EVN, guestId, ...(guestName !== undefined ? { guestName } : {}), key: `k/${id}`, kind: 'photo', contentType: 'image/jpeg',
      originalName: `${id}.jpg`, declaredSize: 10, size: 10, status, uploadId: null,
      createdAt: FieldValue.serverTimestamp(), completedAt: status === 'ready' ? Timestamp.fromMillis(at) : null,
    });
  }
  beforeAll(async () => {
    await seedEvent(db!.db, EVN, { slug: 'names', code: 'NAM' });
    await put(G(1), 1000);                 // anonymous, first
    await put(G(2), 2000, 'Tunde Bello');  // named
    await put(G(3), 3000);                 // anonymous
    await put(G(4), 4000, '');             // empty string stored = anonymous
    await put(G(5), 5000, 'Bisi');         // named
    await put(G(5), 6000, 'Bisi Adeyemi'); // same guest later gives a fuller / corrected name
    await put(G(5), 7000);                 // ...then uploads again WITHOUT a name: keep the last name given
    await put(G(6), 8000, 'Tunde Bello');  // a DIFFERENT guest with the same name
    await put(G(7), 9000, 'Ghost', 'pending'); // never completed: must not name or create a folder
  });

  it('shows the guest\'s name, and numbers only the anonymous guests', async () => {
    const { folders } = await listGuestFolders(db!.db, EVN);
    expect(folders.map((f) => f.label)).toEqual(['Guest 1', 'Tunde Bello', 'Guest 2', 'Guest 3', 'Bisi Adeyemi', 'Tunde Bello (2)']);
    expect(folders.map((f) => f.named)).toEqual([false, true, false, false, true, true]);
  });

  it('a guest who later gives a name takes the latest one, and a later upload without a name does not erase it', async () => {
    const { folders } = await listGuestFolders(db!.db, EVN);
    const bisi = folders.find((f) => f.guestId === G(5))!;
    expect(bisi.label).toBe('Bisi Adeyemi');
    expect(bisi.count).toBe(3);
  });

  it('a pending (never completed) upload neither creates a folder nor sets a name', async () => {
    const { folders } = await listGuestFolders(db!.db, EVN);
    expect(folders.some((f) => f.guestId === G(7))).toBe(false);
    expect(folders.some((f) => f.label === 'Ghost')).toBe(false);
  });

  it('a name never changes which files belong to a folder (folders are opened by guest id)', async () => {
    const r = await listMoments(db!.db, { eventId: EVN, limit: 48, guestId: G(2) });
    expect(r.total).toBe(1);
    const dupe = await listMoments(db!.db, { eventId: EVN, limit: 48, guestId: G(6) });
    expect(dupe.total).toBe(1); // the second "Tunde Bello" is NOT merged into the first
  });

  it('stored names are cleaned again on read (older or hand-edited records cannot inject markup)', async () => {
    await put(G(8), 10000, '<img src=x onerror=alert(1)>');
    const { folders } = await listGuestFolders(db!.db, EVN);
    const f = folders.find((x) => x.guestId === G(8))!;
    expect(f.label).not.toMatch(/[<>]/);
  });
});
