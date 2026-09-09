import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, eventDoc } from './helpers';
import { toggleScanning } from '@/lib/services/scanning';
import { performScan } from '@/lib/services/scan';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

describe.skipIf(!hasEmu)('scanning activation', () => {
  beforeAll(async () => { await seedEvent(db!.db, EV1); });
  afterAll(async () => { await db!.cleanup(); });

  it('activates scanning and the effect is authoritative server state', async () => {
    const res = await toggleScanning(db!.db, { eventId: EV1, enabled: true, actorUid: 'root-uid' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scanningEnabled).toBe(true);
    const ev = await eventDoc(db!.db);
    expect(ev.scanningEnabled).toBe(true);
    expect(ev.scanningEnabledBy).toBe('root-uid');
  });

  it('deactivation takes effect on the very next scan attempt', async () => {
    await toggleScanning(db!.db, { eventId: EV1, enabled: true, actorUid: 'root-uid' });
    const usher = await seedUsher(db!.db, {});
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00080' });

    const first = await performScan(db!.db, {
      usherId: usher.id, eventId: EV1, token: inv.token, clientRequestId: 'req-t1',
    });
    expect(first.code).toBe('ACCEPTED');

    await toggleScanning(db!.db, { eventId: EV1, enabled: false, actorUid: 'root-uid' });

    const inv2 = await seedInvitation(db!.db, { serialNumber: 'ISWED-00081' });
    const second = await performScan(db!.db, {
      usherId: usher.id, eventId: EV1, token: inv2.token, clientRequestId: 'req-t2',
    });
    expect(second.code).toBe('SCANNING_DISABLED');
  });

  it('closed events can never have effective scanning (lifecycle guard)', async () => {
    await db!.db.collection('events').doc(EV1).update({ lifecycleStatus: 'closed' });
    const res = await toggleScanning(db!.db, { eventId: EV1, enabled: true, actorUid: 'root-uid' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scanningEnabled).toBe(false); // forced off by lifecycle status
    await db!.db.collection('events').doc(EV1).update({ lifecycleStatus: 'open' });
  });

  it('unknown event → NOT_FOUND', async () => {
    const res = await toggleScanning(db!.db, { eventId: 'nope-event', enabled: true, actorUid: 'root-uid' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_FOUND');
  });
});
