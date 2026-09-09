import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  makeDb, seedEvent, seedInvitation, seedUsher, EV1, EV2, invitationDoc, scanLogsFor,
} from './helpers';
import { performScan } from '@/lib/services/scan';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

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
