import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, invitationDoc, eventDoc, auditLogsFor } from './helpers';
import { performScan } from '@/lib/services/scan';
import { allowRescan } from '@/lib/services/invitationAdmin';
import { ACTOR } from './helpers';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

describe.skipIf(!hasEmu)('counters and history retention', () => {
  let usher: { id: string; name: string };

  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    usher = await seedUsher(db!.db, {});
  });
  afterAll(async () => { await db!.cleanup(); });

  const scan = (token: string) =>
    performScan(db!.db, {
      usherId: usher.id, eventId: EV1, token,
      clientRequestId: `req-${Math.random().toString(36).slice(2)}`,
    });

  it('scan → release → rescan keeps every counter exact', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00050' });

    await scan(inv.token);
    let ev = await eventDoc(db!.db);
    expect(ev.totalUsed).toBe(1);
    let doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('used');

    await allowRescan(db!.db, { invitationId: inv.digest, reason: 'network failure at gate', admin: ACTOR });
    ev = await eventDoc(db!.db);
    expect(ev.totalUsed).toBe(0);
    expect(ev.rescanAllowedCount).toBe(1);
    doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('unused');
    const usherDoc = (await db!.db.collection('ushers').doc(usher.id).get()).data()!;
    expect(usherDoc.acceptedCount).toBe(0);

    await scan(inv.token);
    ev = await eventDoc(db!.db);
    expect(ev.totalUsed).toBe(1);
    expect(ev.rescanAllowedCount).toBe(1); // release count is cumulative, not reset
    doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('used');
    const usherDoc2 = (await db!.db.collection('ushers').doc(usher.id).get()).data()!;
    expect(usherDoc2.acceptedCount).toBe(1);
  });

  it('audit history accumulates rather than being overwritten', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00051' });
    await scan(inv.token);

    await allowRescan(db!.db, { invitationId: inv.digest, reason: 'first release', admin: ACTOR });
    await scan(inv.token);
    await allowRescan(db!.db, { invitationId: inv.digest, reason: 'second release', admin: ACTOR });
    await scan(inv.token);

    const doc = await invitationDoc(db!.db, inv.digest);
    const history = doc.rescanHistory as { reason: string; allowedByName: string }[];
    expect(history.length).toBe(2);
    expect(history[0].reason).toBe('first release');
    expect(history[1].reason).toBe('second release');
    expect(history.every((h) => h.allowedByName === ACTOR.displayName)).toBe(true);

    const audits = await auditLogsFor(db!.db, 'RESCAN_ALLOWED');
    // 1 release from the previous test in this file + 2 here
    expect(audits.length).toBe(3);
    const ev = await eventDoc(db!.db);
    // event-level cumulative: 1 release from the previous test + 2 here
    expect(ev.rescanAllowedCount).toBe(3);
  });
});
