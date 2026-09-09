import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, invitationDoc, eventDoc } from './helpers';
import { performScan } from '@/lib/services/scan';
import { revokeInvitation, allowRescan } from '@/lib/services/invitationAdmin';
import { ACTOR } from './helpers';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

describe.skipIf(!hasEmu)('transaction integrity under realistic races', () => {
  let usher: { id: string; name: string };

  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    usher = await seedUsher(db!.db, {});
  });
  afterAll(async () => { await db!.cleanup(); });

  const scan = (token: string, usherId = usher.id) =>
    performScan(db!.db, {
      usherId, eventId: EV1, token,
      clientRequestId: `req-${Math.random().toString(36).slice(2)}`,
    });

  // Each race runs several rounds to maximize real contention.
  const ROUNDS = 5;

  it('scan A + scan B on one unused invitation → exactly one admission', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await seedInvitation(db!.db, { serialNumber: `ISWED-9${i}001` });
      const [a, b] = await Promise.all([scan(inv.token), scan(inv.token)]);
      const accepted = [a, b].filter((r) => r.code === 'ACCEPTED');
      const rejected = [a, b].filter((r) => r.code !== 'ACCEPTED');
      expect(accepted.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect(rejected[0].code).toBe('ALREADY_USED');
      const doc = await invitationDoc(db!.db, inv.digest);
      expect(doc.status).toBe('used');
      const ev = await eventDoc(db!.db);
      expect(ev.totalUsed).toBe(i + 1); // counter advanced exactly once per race
    }
  });

  it('scan + revoke race → consistent state (no double-admission, no impossible state)', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await seedInvitation(db!.db, { serialNumber: `ISWED-9${i}002` });
      const [scanRes, revokeRes] = await Promise.all([
        scan(inv.token),
        revokeInvitation(db!.db, { invitationId: inv.digest, reason: 'race test', admin: ACTOR }),
      ]);
      const doc = await invitationDoc(db!.db, inv.digest);
      const ev = await eventDoc(db!.db);
      if (doc.status === 'used') {
        // scan won the race — the revoke must have failed for the RIGHT reason
        expect(scanRes.code).toBe('ACCEPTED');
        expect(revokeRes.ok).toBe(false);
        if (!revokeRes.ok) expect(revokeRes.code).toBe('NOT_UNUSED');
        expect(ev.totalUsed).toBeGreaterThan(0);
      } else if (doc.status === 'revoked') {
        // revoke won the race
        expect(['REVOKED', 'SCANNING_DISABLED']).toContain(scanRes.code);
        expect(scanRes.code).toBe('REVOKED');
      } else {
        throw new Error(`impossible state after race: ${doc.status}`);
      }
      // never both counters incremented for the same invitation
      expect(doc.status).not.toBe('unused');
    }
  });

  it('scan + allow-rescan race on a used invitation → no corrupt state, counters coherent', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await seedInvitation(db!.db, { serialNumber: `ISWED-9${i}003`, status: 'used' });
      const evBefore = (await eventDoc(db!.db)).totalUsed as number;
      const [scanRes, rescanRes] = await Promise.all([
        scan(inv.token),
        allowRescan(db!.db, { invitationId: inv.digest, reason: 'race test rescan', admin: ACTOR }),
      ]);
      const doc = await invitationDoc(db!.db, inv.digest);
      const ev = await eventDoc(db!.db);

      if (scanRes.code === 'ACCEPTED') {
        // release committed first, then the invitation was re-admitted:
        // the release decrement and the new admission increment cancel out
        // relative to the pre-race reading
        expect(rescanRes.ok).toBe(true);
        expect(doc.status).toBe('used');
        expect(ev.totalUsed).toBe(evBefore);
      } else {
        // scan saw it used (original use) while rescan released it: the
        // release moves the invitation back to unused, decrementing the
        // used counter (the fabricated seed never incremented it)
        expect(scanRes.code).toBe('ALREADY_USED');
        expect(rescanRes.ok).toBe(true);
        expect(doc.status).toBe('unused');
        expect(ev.totalUsed).toBe(evBefore - 1);
      }
      expect((doc.rescanHistory as unknown[]).length).toBe(1);
    }
  });

  it('allow-rescan + allow-rescan concurrent → exactly one release succeeds', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const inv = await seedInvitation(db!.db, { serialNumber: `ISWED-9${i}004`, status: 'used' });
      const [a, b] = await Promise.all([
        allowRescan(db!.db, { invitationId: inv.digest, reason: 'rescan A', admin: ACTOR }),
        allowRescan(db!.db, { invitationId: inv.digest, reason: 'rescan B', admin: ACTOR }),
      ]);
      const okCount = [a, b].filter((r) => r.ok).length;
      expect(okCount).toBe(1);
      const doc = await invitationDoc(db!.db, inv.digest);
      expect(doc.status).toBe('unused');
      expect((doc.rescanHistory as unknown[]).length).toBe(1); // history not duplicated
    }
  });
});
