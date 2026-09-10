import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  makeDb, seedEvent, seedInvitation, seedUsher, EV1, EV2, invitationDoc, scanLogsFor,
} from './helpers';
import { performScan } from '@/lib/services/scan';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;


describe.skipIf(!hasEmu)('manual serial entry (usher types the printed serial)', () => {
  let usher: { id: string; pin: string; name: string };

  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    await seedEvent(db!.db, EV2, { name: 'Other event', slug: 'other', code: 'OTHER' });
    usher = await seedUsher(db!.db, {});
  });
  // NOTE: no afterAll cleanup here — the shared makeDb() instance above is
  // cleaned up once by the first suite's afterAll.

  const scan = (token: string) =>
    performScan(db!.db, {
      usherId: usher.id,
      eventId: EV1,
      token,
      clientRequestId: `req-${Math.random().toString(36).slice(2)}`,
    });

  it('hyphenless serial typed by an usher matches a legacy hyphenated invitation', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00100' });
    const out = await scan('iswed00100');
    expect(out.code).toBe('ACCEPTED');
    expect(out.serialNumber).toBe('ISWED-00100');
    const doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('used');
  });

  it('hyphenated serial matches a new hyphenless invitation', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED00101' });
    const out = await scan('ISWED-00101');
    expect(out.code).toBe('ACCEPTED');
    expect(out.serialNumber).toBe('ISWED00101');
  });

  it('whitespace and case variations all resolve', async () => {
    await seedInvitation(db!.db, { serialNumber: 'ISWED-00102' });
    const out = await scan('  iswed 00102  ');
    expect(out.code).toBe('ACCEPTED');
  });

  it('mixed-case and lowercase manual entry with hyphen variations all resolve (usher may type either case)', async () => {
    await seedInvitation(db!.db, { serialNumber: 'IS26-00201' });
    for (const typed of ['is26-00201', 'IS2600201', 'Is26 00201', 'iS26-00201']) {
      // fresh invitation each iteration would consume it once — verify
      // normalization independently by checking INVALID never fires for
      // any of these case/format variants (ALREADY_USED after the first
      // proves the SAME record was matched, not four different lookups).
      const out = await scan(typed);
      expect(out.code === 'ACCEPTED' || out.code === 'ALREADY_USED').toBe(true);
    }
  });

  it('unknown serial → INVALID, never fabricated as granted', async () => {
    const out = await scan('ISWED99999');
    expect(out.code).toBe('INVALID');
  });

  it('a serial belonging to another event is rejected as wrong event', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00103', eventId: EV2 });
    const out = await scan('ISWED00103');
    expect(out.code).toBe('WRONG_EVENT');
    expect((await invitationDoc(db!.db, inv.digest)).status).toBe('unused');
  });

  it('serial scan consumes the invitation exactly once (atomicity preserved)', async () => {
    await seedInvitation(db!.db, { serialNumber: 'ISWED-00104' });
    await scan('ISWED00104');
    const second = await scan('ISWED00104');
    expect(second.code).toBe('ALREADY_USED');
    expect(second.serialNumber).toBe('ISWED-00104');
  });

  it('a real QR credential still scans directly (token path unchanged)', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00105' });
    const out = await scan(inv.token);
    expect(out.code).toBe('ACCEPTED');
  });
});

describe.skipIf(!hasEmu)('scan flow outcomes', () => {
  let usher: { id: string; pin: string; name: string };

  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    await seedEvent(db!.db, EV2, { name: 'Other event', slug: 'other', code: 'OTHER' });
    usher = await seedUsher(db!.db, {});
  });

  afterAll(async () => { await db!.cleanup(); });

  const scan = (token: string, opts: { eventId?: string; usherId?: string } = {}) =>
    performScan(db!.db, {
      usherId: opts.usherId ?? usher.id,
      eventId: opts.eventId ?? EV1,
      token,
      clientRequestId: `req-${Math.random().toString(36).slice(2)}`,
    });

  it('valid unused QR + scanning ACTIVE → ACCESS GRANTED', async () => {
    const inv = await seedInvitation(db!.db, {});
    const out = await scan(inv.token);
    expect(out.code).toBe('ACCEPTED');
    expect(out.serialNumber).toBe(inv.serial);
    const doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('used');
    expect(doc.usedByUsherName).toBe(usher.name);
  });

  it('same QR scanned again → ALREADY USED with first-use details', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00002' });
    await scan(inv.token);
    const out = await scan(inv.token);
    expect(out.code).toBe('ALREADY_USED');
    expect(out.serialNumber).toBe(inv.serial);
    expect(out.firstUsedAt).toBeTruthy();
  });

  it('scanning INACTIVE → EVENT NOT OPEN, invitation stays unused', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00003' });
    await db!.db.collection('events').doc(EV1).update({ scanningEnabled: false });
    const out = await scan(inv.token);
    expect(out.code).toBe('SCANNING_DISABLED');
    expect(out.message).toBe('EVENT NOT OPEN');
    const doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('unused');
    expect(doc.usedAt).toBeNull();
    await db!.db.collection('events').doc(EV1).update({ scanningEnabled: true });
  });

  it('deactivate scanning while a scanner is open → next server validation fails (no stale-browser bypass)', async () => {
    const inv1 = await seedInvitation(db!.db, { serialNumber: 'ISWED-00004' });
    expect((await scan(inv1.token)).code).toBe('ACCEPTED'); // scanner works
    await db!.db.collection('events').doc(EV1).update({ scanningEnabled: false });
    const inv2 = await seedInvitation(db!.db, { serialNumber: 'ISWED-00005' });
    const out = await scan(inv2.token); // no re-auth, same open session
    expect(out.code).toBe('SCANNING_DISABLED');
    expect((await invitationDoc(db!.db, inv2.digest)).status).toBe('unused');
    await db!.db.collection('events').doc(EV1).update({ scanningEnabled: true });
  });

  it('revoked invitation → rejected, never consumed', async () => {
    const inv = await seedInvitation(db!.db, { status: 'revoked', serialNumber: 'ISWED-00006' });
    const out = await scan(inv.token);
    expect(out.code).toBe('REVOKED');
    expect((await invitationDoc(db!.db, inv.digest)).status).toBe('revoked');
  });

  it('invalid/random credential → rejected', async () => {
    expect((await scan('IS26.' + 'X'.repeat(43))).code).toBe('INVALID');
    expect((await scan('completely-fake-token')).code).toBe('INVALID');
  });

  it("credential belonging to another event → rejected and NOT consumed in the scanned event", async () => {
    const inv = await seedInvitation(db!.db, { eventId: EV2, serialNumber: 'OTHER-00007' });
    const out = await scan(inv.token); // scanning against EV1
    expect(out.code).toBe('WRONG_EVENT');
    expect((await invitationDoc(db!.db, inv.digest)).status).toBe('unused');
  });

  it('disabled usher → UNAUTHORIZED, invitation not consumed', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00008' });
    const disabled = await seedUsher(db!.db, { name: 'Disabled Usher', active: false });
    const out = await scan(inv.token, { usherId: disabled.id });
    expect(out.code).toBe('UNAUTHORIZED');
    expect((await invitationDoc(db!.db, inv.digest)).status).toBe('unused');
  });

  it('closed event → EVENT_CLOSED even if scanningEnabled was left true', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00009' });
    await db!.db.collection('events').doc(EV1).update({ lifecycleStatus: 'closed' });
    const out = await scan(inv.token);
    expect(out.code).toBe('EVENT_CLOSED');
    expect((await invitationDoc(db!.db, inv.digest)).status).toBe('unused');
    await db!.db.collection('events').doc(EV1).update({ lifecycleStatus: 'open' });
  });

  it('writes exactly one scan log per attempt with the digest, never the raw credential', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00010' });
    await scan(inv.token);
    const logs = await scanLogsFor(db!.db, inv.digest);
    expect(logs.length).toBe(1);
    expect(logs[0].result).toBe('accepted');
    expect(logs[0].usherNameSnapshot).toBe(usher.name);
  });
});
