import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, EV1, EV2 } from './helpers';
import { scanInvitations, listTags, matchesText, matchesTag, SCAN_PAGE } from '@/lib/services/invitationSearch';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;
const pad = (n: number) => String(n).padStart(5, '0');

describe('matching rules (pure)', () => {
  it('finds part of a serial, ignoring case, spaces and hyphens', () => {
    const d = { serialNumber: 'ISWED00042', tag: null };
    for (const t of ['00042', '42', 'iswed', 'ISWED-00042', 'wed 000', 'is-wed00042']) expect(matchesText(d, t), t).toBe(true);
    expect(matchesText(d, '99999')).toBe(false);
  });
  it('legacy hyphenated serials match the same text', () => {
    expect(matchesText({ serialNumber: 'ISWED-00042' }, '00042')).toBe(true);
    expect(matchesText({ serialNumber: 'ISWED-00042' }, 'ISWED00042')).toBe(true);
  });
  it('matches on the tag too, case-insensitively', () => {
    expect(matchesText({ serialNumber: 'ISWED00001', tag: 'VIP Table' }, 'vip')).toBe(true);
    expect(matchesText({ serialNumber: 'ISWED00001', tag: 'VIP Table' }, 'family')).toBe(false);
  });
  it('empty text matches everything; tag filter modes work', () => {
    expect(matchesText({ serialNumber: 'A1' }, '   ')).toBe(true);
    expect(matchesTag({ tag: 'VIP' }, undefined)).toBe(true);
    expect(matchesTag({ tag: 'VIP' }, '__tagged__')).toBe(true);
    expect(matchesTag({ tag: null }, '__tagged__')).toBe(false);
    expect(matchesTag({ tag: '  ' }, '__untagged__')).toBe(true);
    expect(matchesTag({ tag: 'vip' }, 'VIP')).toBe(true);
    expect(matchesTag({ tag: 'FAMILY' }, 'VIP')).toBe(false);
  });
});

describe.skipIf(!hasEmu)('invitation search over a long list', () => {
  // 1..1100 for EV1 (spans 3 scan pages), with sprinkled tags and statuses; a few for EV2.
  beforeAll(async () => {
    await seedEvent(db!.db, EV1); await seedEvent(db!.db, EV2, { slug: 'other-event', code: 'OTHER' });
    const batch = db!.db.batch(); // placeholder to keep import used
    void batch;
    const writes: Promise<unknown>[] = [];
    for (let n = 1; n <= 1100; n++) {
      const status = n % 10 === 0 ? 'used' : n % 37 === 0 ? 'revoked' : 'unused';
      const tag = n % 100 === 0 ? 'VIP' : n % 250 === 0 ? 'Family' : null;
      writes.push(seedInvitation(db!.db, { eventId: EV1, serialNumber: `ISWED${pad(n)}`, status, tag }));
      if (writes.length >= 100) { await Promise.all(writes.splice(0)); }
    }
    await Promise.all(writes);
    // legacy hyphenated serial + another event's invitation with the same numbers
    await seedInvitation(db!.db, { eventId: EV1, serialNumber: 'ISWED-09999', status: 'unused' });
    await seedInvitation(db!.db, { eventId: EV2, serialNumber: 'OTHER00042', status: 'unused' });
    await seedInvitation(db!.db, { eventId: EV2, serialNumber: 'OTHER00100', status: 'unused', tag: 'VIP' });
  }, 120_000);
  afterAll(async () => { await db!.cleanup(); });

  const scan = (f: Partial<Parameters<typeof scanInvitations>[1]>) => scanInvitations(db!.db, { eventId: EV1, text: '', ...f });

  it('seeded more than two scan pages, so paging across pages is really exercised', () => {
    expect(1101).toBeGreaterThan(SCAN_PAGE * 2);
  });

  it('finds an invitation deep in the list (past the first pages) by partial number', async () => {
    const r = await scan({ text: '01050' });
    expect(r.docs.map((d) => d.data.serialNumber)).toEqual(['ISWED01050']);
    expect(r.truncated).toBe(false);
  });

  it('partial number returns every match (including ones containing it mid-number), in serial order', async () => {
    const r = await scan({ text: '0104' });
    const got = r.docs.map((d) => String(d.data.serialNumber));
    // 00104 contains "0104" in its digits, so it must be found too
    expect(got).toEqual(['ISWED00104', ...Array.from({ length: 10 }, (_, i) => `ISWED${pad(1040 + i)}`)]);
    expect(got).toEqual([...got].sort());
  });

  it('finds the legacy hyphenated serial by its digits', async () => {
    const r = await scan({ text: '9999' });
    expect(r.docs.map((d) => d.data.serialNumber)).toContain('ISWED-09999');
  });

  it('never returns another event\'s invitations', async () => {
    const r = await scan({ text: '00042' });
    expect(r.docs.every((d) => d.data.eventId === EV1)).toBe(true);
    expect(r.docs.map((d) => d.data.serialNumber)).toEqual(['ISWED00042']);
    expect((await scanInvitations(db!.db, { eventId: EV2, text: '00042' })).docs.map((d) => d.data.serialNumber)).toEqual(['OTHER00042']);
  });

  it('status filter narrows results and the counts are exact', async () => {
    const used = await scan({ status: 'used' });
    expect(used.docs).toHaveLength(Math.floor(1100 / 10));
    expect(used.docs.every((d) => d.data.status === 'used')).toBe(true);
    const revoked = await scan({ status: 'revoked' });
    const expected = Array.from({ length: 1100 }, (_, i) => i + 1).filter((n) => n % 10 !== 0 && n % 37 === 0).length;
    expect(revoked.docs).toHaveLength(expected);
  });

  it('tag filter: a specific tag, any tag, and no tag', async () => {
    expect((await scan({ tag: 'VIP' })).docs).toHaveLength(11);              // 100,200,...,1100
    expect((await scan({ tag: 'vip' })).docs).toHaveLength(11);              // case-insensitive
    expect((await scan({ tag: 'Family' })).docs).toHaveLength(Array.from({ length: 1100 }, (_, i) => i + 1).filter((n) => n % 250 === 0 && n % 100 !== 0).length);
    const tagged = await scan({ tag: '__tagged__' });
    const untagged = await scan({ tag: '__untagged__' });
    expect(tagged.docs.length + untagged.docs.length).toBe(1101); // 1100 + the legacy hyphenated one
  });

  it('text + status + tag combine (all must hold)', async () => {
    const r = await scan({ text: '00', status: 'used', tag: 'VIP' });
    expect(r.docs.length).toBeGreaterThan(0);
    expect(r.docs.every((d) => d.data.status === 'used' && d.data.tag === 'VIP' && String(d.data.serialNumber).includes('00'))).toBe(true);
  });

  it('searching by tag text finds tagged invitations', async () => {
    const r = await scan({ text: 'family' });
    expect(r.docs.every((d) => d.data.tag === 'Family')).toBe(true);
    expect(r.docs.length).toBeGreaterThan(0);
  });

  it('no match gives an empty, non-truncated result', async () => {
    expect(await scan({ text: 'zzzzz' })).toEqual({ docs: [], truncated: false });
  });

  it('tag list is distinct, sorted, and scoped to the event', async () => {
    expect(await listTags(db!.db, EV1)).toEqual(['Family', 'VIP']);
    expect(await listTags(db!.db, EV2)).toEqual(['VIP']);
  });
});
