import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { makeDb, seedEvent, seedUsher, seedInvitation, EV1, invitationDoc } from './helpers';
import { usherSignIn, verifyUsherActive, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES } from '@/lib/services/usherAuth';
import { performScan } from '@/lib/services/scan';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

describe.skipIf(!hasEmu)('usher authentication', () => {
  beforeAll(async () => { await seedEvent(db!.db, EV1); });
  afterAll(async () => { await db!.cleanup(); });

  const tryPin = (name: string, pin: string) =>
    usherSignIn(db!.db, { eventId: EV1, name, pin });

  it('correct name + PIN signs in; PIN is never stored plaintext', async () => {
    const u = await seedUsher(db!.db, { name: 'Grace Usher', pin: '998877' });
    const res = await tryPin('Grace Usher', '998877');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const doc = (await db!.db.collection('ushers').doc(u.id).get()).data()!;
    expect(JSON.stringify(doc)).not.toContain('998877'); // only the hashed verifier is stored
    expect(doc.pinVerifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it('wrong PIN fails (uniform error) and counts the attempt', async () => {
    await seedUsher(db!.db, { name: 'Peter Usher', pin: '111222' });
    const res = await tryPin('Peter Usher', '000000');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('INVALID');
    const snap = await db!.db.collection('ushers').where('normalizedName', '==', 'peter usher').get();
    expect(snap.docs[0].data().failedAttempts).toBe(1);
  });

  it('repeated wrong PINs trigger the configured temporary lockout', async () => {
    await seedUsher(db!.db, { name: 'Lock Usher', pin: '555444' });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const res = await tryPin('Lock Usher', '000000');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('INVALID');
    }
    const snap = await db!.db.collection('ushers').where('normalizedName', '==', 'lock usher').get();
    const doc = snap.docs[0].data();
    expect((doc.lockedUntil as Timestamp).toMillis()).toBeGreaterThan(Date.now());
  });

  it('correct PIN does NOT bypass an active lockout', async () => {
    const u = await seedUsher(db!.db, { name: 'Locked Usher', pin: '777666', lockedUntil: new Date(Date.now() + 10 * 60_000) });
    const res = await tryPin('Locked Usher', '777666'); // the RIGHT pin
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('LOCKED');
    expect(res.lockedMinutes).toBeGreaterThan(0);
  });

  it('lockout expires and the correct PIN works again', async () => {
    await seedUsher(db!.db, { name: 'Freed Usher', pin: '321321', lockedUntil: new Date(Date.now() - 60_000) });
    const res = await tryPin('Freed Usher', '321321');
    expect(res.ok).toBe(true);
  });

  it('disabled usher cannot sign in and verifyUsherActive returns null', async () => {
    await seedUsher(db!.db, { name: 'Off Usher', pin: '456456', active: false });
    const res = await tryPin('Off Usher', '456456');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('DISABLED');
    const active = await verifyUsherActive(db!.db, (await db!.db.collection('ushers').where('normalizedName', '==', 'off usher').get()).docs[0].id);
    expect(active).toBeNull();
  });

  it('disabling an usher invalidates the next scan from their already-open scanner', async () => {
    const u = await seedUsher(db!.db, { name: 'Live Usher', pin: '654321' });
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00070' });

    // session works
    const ok = await performScan(db!.db, {
      usherId: u.id, eventId: EV1, token: inv.token, clientRequestId: 'req-live-1',
    });
    expect(ok.code).toBe('ACCEPTED');

    // admin disables the usher while the scanner page stays open
    await db!.db.collection('ushers').doc(u.id).update({ active: false });

    const inv2 = await seedInvitation(db!.db, { serialNumber: 'ISWED-00071' });
    const out = await performScan(db!.db, {
      usherId: u.id, eventId: EV1, token: inv2.token, clientRequestId: 'req-live-2',
    });
    expect(out.code).toBe('UNAUTHORIZED');
    expect((await invitationDoc(db!.db, inv2.digest)).status).toBe('unused');
  });
});
