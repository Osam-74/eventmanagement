import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, EV2, invitationDoc, eventDoc, ACTOR, auditLogsFor } from './helpers';
import { performScan } from '@/lib/services/scan';
import { setInvitationTables, parseTableNumber, tableForDisplay } from '@/lib/services/invitationTable';
import { matchesText } from '@/lib/services/invitationSearch';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;
const admin = { uid: ACTOR.uid, displayName: ACTOR.displayName, email: ACTOR.email };

describe('table parsing (pure)', () => {
  it('accepts normal tables and normalises spacing', () => {
    for (const [i, o] of [['12', '12'], [' A3 ', 'A3'], ['Table   4', 'Table 4'], ['VIP-2', 'VIP-2'], ['Head Table', 'Head Table'], ['5/6', '5/6'], ['Mesa ñ 3', 'Mesa ñ 3']] as const) {
      expect(parseTableNumber(i), i).toEqual({ ok: true, value: o });
    }
  });
  it('blank / null clears', () => {
    expect(parseTableNumber('')).toEqual({ ok: true, value: null });
    expect(parseTableNumber('   ')).toEqual({ ok: true, value: null });
    expect(parseTableNumber(null)).toEqual({ ok: true, value: null });
  });
  it('rejects too long and odd characters (no markup / script text)', () => {
    expect(parseTableNumber('x'.repeat(25)).ok).toBe(false);
    expect(parseTableNumber('<b>1</b>').ok).toBe(false);
    expect(parseTableNumber('1; drop').ok).toBe(false);
    expect(parseTableNumber(12 as unknown as string).ok).toBe(false);
  });
  it('display: only non-blank strings show', () => {
    expect(tableForDisplay(undefined)).toBeNull();
    expect(tableForDisplay(null)).toBeNull();
    expect(tableForDisplay('   ')).toBeNull();
    expect(tableForDisplay(7)).toBeNull();
    expect(tableForDisplay(' 12 ')).toBe('12');
  });
  it('search matches the table too', () => {
    expect(matchesText({ serialNumber: 'ISWED00001', tableNumber: 'A3' }, 'a3')).toBe(true);
    expect(matchesText({ serialNumber: 'ISWED00001', tableNumber: null }, 'a3')).toBe(false);
  });
});

describe.skipIf(!hasEmu)('table number on real cards', () => {
  let usher: { id: string; name: string };
  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    await seedEvent(db!.db, EV2, { slug: 'other', code: 'OTHER' });
    usher = await seedUsher(db!.db, {});
  });
  afterAll(async () => { await db!.cleanup(); });

  const scan = (token: string) =>
    performScan(db!.db, { usherId: usher.id, eventId: EV1, token, clientRequestId: `req-${Math.random().toString(36).slice(2)}` });
  const raw = async (digest: string) => (await db!.db.collection('invitations').doc(digest).get()).data()!;

  // ---------- scan: cards WITHOUT a table are exactly as before ----------
  it('a card with no table scans exactly as before: no table key at all', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00301', tag: 'FAMILY', usageLimit: 1 });
    const out = await scan(inv.token);
    expect(out.code).toBe('ACCEPTED');
    expect('tableNumber' in out).toBe(false);
    expect(out.tag).toBe('FAMILY');
    expect(out.serialNumber).toBe('ISWED-00301');
    expect(out.usageCount).toBe(1);
  });

  it('a blank / whitespace table behaves as "no table"', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00302', tag: 'VIP' });
    await db!.db.collection('invitations').doc(inv.digest).update({ tableNumber: '   ' });
    const out = await scan(inv.token);
    expect(out.code).toBe('ACCEPTED');
    expect('tableNumber' in out).toBe(false);
  });

  // ---------- scan: cards WITH a table ----------
  it('access granted shows the table (and the tag/serial as before)', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00303', tag: 'FAMILY' });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '12', admin });
    const out = await scan(inv.token);
    expect(out).toMatchObject({ code: 'ACCEPTED', tableNumber: '12', tag: 'FAMILY', serialNumber: 'ISWED00303', usageCount: 1 });
  });

  it('a returning guest (already used) still shows the table to the usher', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00304', tag: 'VIP' });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: 'A3', admin });
    await scan(inv.token);
    const again = await scan(inv.token);
    expect(again.code).toBe('ALREADY_USED');
    expect(again.tableNumber).toBe('A3');
  });

  it('works for unlimited and multi-use cards, counting exactly as before', async () => {
    const unl = await seedInvitation(db!.db, { serialNumber: 'ISWED00305', tag: 'FAMILY', usageLimit: null });
    const multi = await seedInvitation(db!.db, { serialNumber: 'ISWED00306', tag: 'FAMILY', usageLimit: 3 });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [unl.digest, multi.digest], table: '5', admin });
    for (let i = 1; i <= 4; i++) {
      const o = await scan(unl.token);
      expect(o).toMatchObject({ code: 'ACCEPTED', tableNumber: '5', usageCount: i, usageLimit: null });
    }
    for (let i = 1; i <= 3; i++) expect(await scan(multi.token)).toMatchObject({ code: 'ACCEPTED', tableNumber: '5', usageCount: i, usageLimit: 3 });
    expect(await scan(multi.token)).toMatchObject({ code: 'ALREADY_USED', tableNumber: '5' });
    expect((await raw(multi.digest)).status).toBe('used');
    expect((await raw(unl.digest)).status).toBe('unused');
  });

  it('a legacy card (no usageLimit/usageCount fields, hyphenated serial) + table still scans correctly', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00307', tag: 'FAMILY' });
    await db!.db.collection('invitations').doc(inv.digest).update({
      usageLimit: (await import('firebase-admin/firestore')).FieldValue.delete(),
      usageCount: (await import('firebase-admin/firestore')).FieldValue.delete(),
    });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '9', admin });
    const out = await scan(inv.token);
    expect(out).toMatchObject({ code: 'ACCEPTED', tableNumber: '9', serialNumber: 'ISWED-00307', usageCount: 1, usageLimit: 1 });
  });

  it('revoked and invalid cards never show a table', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00308', status: 'revoked' });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '7', admin });
    const out = await scan(inv.token);
    expect(out.code).toBe('REVOKED');
    expect('tableNumber' in out).toBe(false);
    const bogus = await scan('IS26.' + 'a'.repeat(43));
    expect(bogus.code).toBe('INVALID');
    expect('tableNumber' in bogus).toBe(false);
  });

  it('a card from another event is rejected and reveals no table', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'OTHER00309', eventId: EV2 });
    await setInvitationTables(db!.db, { eventId: EV2, invitationIds: [inv.digest], table: '3', admin });
    const out = await scan(inv.token);
    expect(out.code).toBe('WRONG_EVENT');
    expect('tableNumber' in out).toBe(false);
  });

  // ---------- the "nothing else on the card changes" guarantee ----------
  it('setting a table changes ONLY tableNumber: every other stored field is identical', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00310', tag: 'FAMILY', usageLimit: null, status: 'used', usedByUsherId: usher.id });
    const before = await raw(inv.digest);
    const evBefore = await eventDoc(db!.db, EV1);
    const r = await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '21', admin });
    expect(r).toMatchObject({ ok: true, changed: 1 });
    const after = await raw(inv.digest);
    const { tableNumber, ...rest } = after;
    expect(tableNumber).toBe('21');
    expect(rest).toEqual(before); // image path, tag, serial, status, counters, QR identity: all untouched
    expect(await eventDoc(db!.db, EV1)).toEqual(evBefore); // no event counter moved
  });

  it('the QR identity (document id) and image path never change', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00311', tag: 'VIP' });
    const path = (await raw(inv.digest)).imageStoragePath;
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '1', admin });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '2', admin });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: null, admin });
    expect((await raw(inv.digest)).imageStoragePath).toBe(path);
    expect((await scan(inv.token)).code).toBe('ACCEPTED'); // same QR still redeems after 3 edits
  });

  // ---------- editing behaviour ----------
  it('changing then clearing a table is reflected on the next scan; clearing removes it from the result', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00312', usageLimit: null });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '4', admin });
    expect((await scan(inv.token)).tableNumber).toBe('4');
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '8', admin });
    expect((await scan(inv.token)).tableNumber).toBe('8');
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '', admin });
    const out = await scan(inv.token);
    expect(out.code).toBe('ACCEPTED');
    expect('tableNumber' in out).toBe(false);
  });

  it('bulk: one table on many cards; already-set cards counted as unchanged', async () => {
    const a = await seedInvitation(db!.db, { serialNumber: 'ISWED00313', tag: 'FAMILY' });
    const b = await seedInvitation(db!.db, { serialNumber: 'ISWED00314', tag: 'FAMILY' });
    const c = await seedInvitation(db!.db, { serialNumber: 'ISWED00315', tag: 'FAMILY' });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [a.digest], table: '30', admin });
    const r = await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [a.digest, b.digest, c.digest], table: '30', admin });
    expect(r).toEqual({ ok: true, changed: 2, unchanged: 1, skipped: [] });
    for (const x of [a, b, c]) expect((await raw(x.digest)).tableNumber).toBe('30');
  });

  it('bulk never touches another event\'s cards, and reports missing ones without writing', async () => {
    const mine = await seedInvitation(db!.db, { serialNumber: 'ISWED00316' });
    const theirs = await seedInvitation(db!.db, { serialNumber: 'OTHER00317', eventId: EV2 });
    const r = await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [mine.digest, theirs.digest, 'does-not-exist'], table: '40', admin });
    expect(r).toMatchObject({ ok: true, changed: 1 });
    expect(r.ok && r.skipped.map((s) => s.id).sort()).toEqual(['does-not-exist', theirs.digest].sort());
    expect('tableNumber' in (await raw(theirs.digest))).toBe(false);
    expect((await db!.db.collection('invitations').doc('does-not-exist').get()).exists).toBe(false);
  });

  it('invalid input is refused and writes nothing', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00318' });
    const before = await raw(inv.digest);
    for (const bad of ['<script>', 'x'.repeat(30)]) {
      const r = await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: bad, admin });
      expect(r.ok).toBe(false);
    }
    expect((await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [], table: '1', admin })).ok).toBe(false);
    expect(await raw(inv.digest)).toEqual(before);
  });

  it('every change is audit-logged with who and the new value', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00319' });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '77', admin });
    const logs = await auditLogsFor(db!.db, 'INVITATION_TABLE_CHANGED');
    const mine = logs.find((l: Record<string, any>) => l.detail?.cards?.some((c: any) => c.id === inv.digest));
    expect(mine).toBeTruthy();
    expect(mine!.actor).toBe(admin.uid);
    expect(mine!.detail.to).toBe('77');
  });

  it('a no-op edit writes no audit entry', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00320' });
    await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '55', admin });
    const n = (await auditLogsFor(db!.db, 'INVITATION_TABLE_CHANGED')).length;
    const r = await setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '55', admin });
    expect(r).toMatchObject({ ok: true, changed: 0, unchanged: 1 });
    expect((await auditLogsFor(db!.db, 'INVITATION_TABLE_CHANGED')).length).toBe(n);
  });

  it('a scan racing a table edit is never lost or double-counted', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00321', usageLimit: 1 });
    const results = await Promise.all([
      scan(inv.token),
      setInvitationTables(db!.db, { eventId: EV1, invitationIds: [inv.digest], table: '99', admin }),
      scan(inv.token),
    ]);
    const scans = [results[0], results[2]] as Awaited<ReturnType<typeof scan>>[];
    expect(scans.filter((s) => s.code === 'ACCEPTED')).toHaveLength(1); // exactly one admission
    const d = await raw(inv.digest);
    expect(d.usageCount).toBe(1);
    expect(d.status).toBe('used');
    expect(d.tableNumber).toBe('99');
  });
});
