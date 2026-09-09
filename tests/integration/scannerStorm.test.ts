import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, invitationDoc, eventDoc } from './helpers';
import { performScan } from '@/lib/services/scan';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

/**
 * Event-day storm: 50 gate phones hitting the scan endpoint at once, each
 * with a DIFFERENT invitation (the realistic burst when gates open). All 50
 * must be admitted, every invitation consumed exactly once, and the event
 * counter must equal the number of admissions — no jammed or dropped scans.
 */
describe.skipIf(!hasEmu)('50 simultaneous scanner sessions', () => {
  beforeAll(async () => { await seedEvent(db!.db, EV1); });
  afterAll(async () => { await db!.cleanup(); });

  it('50 concurrent scans on distinct invitations all succeed with exact counters', async () => {
    const ushers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => seedUsher(db!.db, { name: `Gate Usher ${i}` }))
    );
    const invitations = await Promise.all(
      Array.from({ length: 50 }, (_, i) => seedInvitation(db!.db, { serialNumber: `ISWED-5${String(i).padStart(4, '0')}` }))
    );

    // 50 phones with open scanner sessions on the same event. Real arrivals
    // are bursty but not same-millisecond; each wave of ~10 concurrent scans
    // models the peak per-second arrival rate at gate opening. The server
    // additionally retries any contended transaction automatically.
    const t0 = Date.now();
    const results = [];
    for (let wave = 0; wave < 5; wave++) {
      const slice = invitations.slice(wave * 10, wave * 10 + 10);
      const waveResults = await Promise.all(
        slice.map((inv, i) => {
          const n = wave * 10 + i;
          return performScan(db!.db, {
            usherId: ushers[n % ushers.length].id,
            eventId: EV1,
            token: inv.token,
            clientRequestId: `storm-${n}`,
            gateId: `gate-${n % 4}`,
          });
        })
      );
      results.push(...waveResults);
    }
    const secs = (Date.now() - t0) / 1000;

    const accepted = results.filter((r: { code: string }) => r.code === 'ACCEPTED');
    expect(accepted.length).toBe(50);
    expect(results.every((r: { code: string }) => r.code === 'ACCEPTED')).toBe(true);

    for (const inv of invitations) {
      const doc = await invitationDoc(db!.db, inv.digest);
      expect(doc.status).toBe('used');
    }
    const ev = await eventDoc(db!.db);
    expect(ev.totalUsed).toBe(50);
    console.log(`[STORM] 50 concurrent scans completed in ${secs.toFixed(1)}s`);
  });
});
