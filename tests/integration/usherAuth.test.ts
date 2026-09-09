import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { makeDb, seedEvent, seedUsher, seedInvitation, EV1, invitationDoc } from './helpers';
import {
  usherSignIn,
  createUsher,
  resetUsherPin,
  setUsherActive,
  verifyUsherActive,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES,
} from '@/lib/services/usherAuth';
import { performScan } from '@/lib/services/scan';
import { pinLookupIndex, pinVerifier } from '@/lib/auth/pin';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

describe.skipIf(!hasEmu)('PIN-only usher authentication', () => {
  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    // extra event for the "assigned event" resolution test
    await seedEvent(db!.db, 'event-two');
  });
  afterAll(async () => { await db!.cleanup(); });

  const tryPin = (pin: string) => usherSignIn(db!.db, { pin });

  it('a PIN alone resolves the usher AND the admin-assigned event; nothing is stored plaintext', async () => {
    const u = await seedUsher(db!.db, { name: 'Grace Usher', pin: '998877', eventId: 'event-two' });
    const res = await tryPin('998877');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.usher.id).toBe(u.id);
    expect(res.usher.name).toBe('Grace Usher');
    expect(res.eventId).toBe('event-two'); // from the usher record — never the browser
    const doc = (await db!.db.collection('ushers').doc(u.id).get()).data()!;
    expect(JSON.stringify(doc)).not.toContain('998877'); // only keyed digests stored
    expect(doc.pinVerifier).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.pinIndex).toBe(pinLookupIndex('998877'));
  });

  it('a different usher with a different PIN resolves to a different identity and event', async () => {
    const a = await seedUsher(db!.db, { name: 'Ada Usher', pin: '112233', eventId: EV1 });
    const res = await tryPin('112233');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.usher.id).toBe(a.id);
    expect(res.eventId).toBe(EV1);
  });

  it('a mistyped PIN (unassigned index) fails with the SAME uniform message', async () => {
    await seedUsher(db!.db, { name: 'Peter Usher', pin: '111222' });
    const res = await tryPin('111223'); // typo of a real PIN — index does not exist
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_FOUND');
    expect(res.message).toBe('Invalid PIN.'); // same message as a verifier mismatch
    // No account is attributed (nothing to lock out on a blind guess).
    const snap = await db!.db.collection('ushers').where('normalizedName', '==', 'peter usher').get();
    expect(snap.docs[0].data().failedAttempts ?? 0).toBe(0);
  });

  it('a registry-resolved account whose verifier fails counts the attempt (stale-index defense)', async () => {
    const u = await seedUsher(db!.db, { name: 'Stale Usher', pin: '111222' });
    // Simulate a stale/mismatched verifier: the registry resolves the
    // account, but the per-account confirmation key does not match.
    await db!.db.collection('ushers').doc(u.id).update({ pinVerifier: pinVerifier(u.id, '999999') });
    const res = await tryPin('111222');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('INVALID');
    const doc = (await db!.db.collection('ushers').doc(u.id).get()).data()!;
    expect(doc.failedAttempts).toBe(1);
  });

  it('an unassigned PIN fails with the same uniform INVALID error (no existence leak)', async () => {
    const res = await tryPin('000000');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_FOUND');
    expect(res.message).toBe('Invalid PIN.');
  });

  it('repeated verifier failures on a resolved account trigger the lockout', async () => {
    const u = await seedUsher(db!.db, { name: 'Lock Usher', pin: '555444' });
    await db!.db.collection('ushers').doc(u.id).update({ pinVerifier: pinVerifier(u.id, '999999') });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      const res = await tryPin('555444');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('INVALID');
    }
    const doc = (await db!.db.collection('ushers').doc(u.id).get()).data()!;
    expect((doc.lockedUntil as Timestamp).toMillis()).toBeGreaterThan(Date.now());
  });

  it('the correct PIN does NOT bypass an active lockout', async () => {
    await seedUsher(db!.db, { name: 'Locked Usher', pin: '777666', lockedUntil: new Date(Date.now() + 10 * 60_000) });
    const res = await tryPin('777666'); // the RIGHT pin
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('LOCKED');
    expect(res.lockedMinutes).toBeGreaterThan(0);
  });

  it('lockout expires and the correct PIN works again', async () => {
    await seedUsher(db!.db, { name: 'Freed Usher', pin: '321321', lockedUntil: new Date(Date.now() - 60_000) });
    const res = await tryPin('321321');
    expect(res.ok).toBe(true);
  });

  it('a disabled usher (released PIN) cannot sign in — uniform Invalid PIN.', async () => {
    const u = await seedUsher(db!.db, { name: 'Off Usher', pin: '456456' });
    await setUsherActive(db!.db, { usherId: u.id, active: false }); // releases the index
    const res = await tryPin('456456');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_FOUND'); // PIN no longer resolves — no existence leak
    expect(res.message).toBe('Invalid PIN.');
    expect(await verifyUsherActive(db!.db, u.id)).toBeNull();
  });

  it('a registry entry still pointing at a disabled record yields the explicit DISABLED error', async () => {
    const u = await seedUsher(db!.db, { name: 'Legacy Off Usher', pin: '786786' });
    // Stale state: registry not released (legacy data from before v1.3.0).
    await db!.db.collection('ushers').doc(u.id).update({ active: false });
    const res = await tryPin('786786');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('DISABLED');
  });

  /* ── PIN registry: uniqueness among ACTIVE ushers ──────────────────── */

  it('admin cannot create two active ushers with the same PIN', async () => {
    const first = await createUsher(db!.db, { eventId: EV1, name: 'Unique One', pin: '808080', createdBy: 'admin-x' });
    expect(first.ok).toBe(true);
    const second = await createUsher(db!.db, { eventId: EV1, name: 'Unique Two', pin: '808080', createdBy: 'admin-x' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('PIN_TAKEN');
    // across events too — active PINs are globally unique
    const third = await createUsher(db!.db, { eventId: 'event-two', name: 'Unique Three', pin: '808080', createdBy: 'admin-x' });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.code).toBe('PIN_TAKEN');
  });

  it('PIN reset enforces the same uniqueness check and moves the registry atomically', async () => {
    const u = await createUsher(db!.db, { eventId: EV1, name: 'Resetter', pin: '717171', createdBy: 'admin-x' });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    const other = await createUsher(db!.db, { eventId: EV1, name: 'Holder', pin: '727272', createdBy: 'admin-x' });
    expect(other.ok).toBe(true);
    if (!other.ok) return;

    // cannot reset ONTO someone else's active PIN
    const clash = await resetUsherPin(db!.db, { usherId: (u as { id: string }).id, newPin: '727272' });
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.code).toBe('PIN_TAKEN');

    // a free PIN works; the old index is released
    const ok = await resetUsherPin(db!.db, { usherId: (u as { id: string }).id, newPin: '737373' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const signInOld = await tryPin('717171');
    expect(signInOld.ok).toBe(false); // old PIN released
    const signInNew = await tryPin('737373');
    expect(signInNew.ok).toBe(true);
  });

  it('disabling an usher releases the PIN; enabling re-claims it; a stolen PIN blocks enabling', async () => {
    const u = await createUsher(db!.db, { eventId: EV1, name: 'Relay One', pin: '646464', createdBy: 'admin-x' });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    const uid = (u as { id: string }).id;

    // disable → PIN freed
    const off = await setUsherActive(db!.db, { usherId: uid, active: false });
    expect(off.ok).toBe(true);
    const freed = await tryPin('646464');
    expect(freed.ok).toBe(false);

    // another usher takes the PIN while the first is disabled
    const taker = await createUsher(db!.db, { eventId: 'event-two', name: 'Relay Taker', pin: '646464', createdBy: 'admin-x' });
    expect(taker.ok).toBe(true);

    // enabling the first usher now fails — the PIN was reassigned
    const back = await setUsherActive(db!.db, { usherId: uid, active: true });
    expect(back.ok).toBe(false);
    if (back.ok) return;
    expect(back.code).toBe('PIN_REASSIGNED');

    // after a PIN reset the usher can be enabled again
    const reset = await resetUsherPin(db!.db, { usherId: uid, newPin: '656565' });
    expect(reset.ok).toBe(true);
    const enabled = await setUsherActive(db!.db, { usherId: uid, active: true });
    expect(enabled.ok).toBe(true);
  });

  /* ── Analytics attribution under PIN-only auth ─────────────────────── */

  it('two PIN-authenticated ushers produce correctly separated analytics attribution', async () => {
    const a = await seedUsher(db!.db, { name: 'Scan Usher A', pin: '242424', eventId: EV1 });
    const b = await seedUsher(db!.db, { name: 'Scan Usher B', pin: '343434', eventId: EV1 });
    const invA = await seedInvitation(db!.db, { serialNumber: 'ISWED-00081' });
    const invB = await seedInvitation(db!.db, { serialNumber: 'ISWED-00082' });

    // resolve both by PIN — the session would carry exactly these identities
    const ra = await tryPin('242424');
    const rb = await tryPin('343434');
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    const scanA = await performScan(db!.db, { usherId: a.id, eventId: EV1, token: invA.token, clientRequestId: 'req-attr-a' });
    const scanB = await performScan(db!.db, { usherId: b.id, eventId: EV1, token: invB.token, clientRequestId: 'req-attr-b' });
    expect(scanA.code).toBe('ACCEPTED');
    expect(scanB.code).toBe('ACCEPTED');

    const snap = await db!.db.collection('scanLogs').get();
    const logs = snap.docs.map((d) => d.data());
    const byUsherA = logs.filter((l) => l.usherId === a.id && l.result === 'accepted');
    const byUsherB = logs.filter((l) => l.usherId === b.id && l.result === 'accepted');
    expect(byUsherA.length).toBe(1);
    expect(byUsherB.length).toBe(1);
    expect(byUsherA[0].usherNameSnapshot).toBe('Scan Usher A');
    expect(byUsherB[0].usherNameSnapshot).toBe('Scan Usher B');
    expect(byUsherA[0].invitationSerialNumber).toBe('ISWED-00081');
    expect(byUsherB[0].invitationSerialNumber).toBe('ISWED-00082');

    // per-usher counters moved separately
    const aDoc = (await db!.db.collection('ushers').doc(a.id).get()).data()!;
    const bDoc = (await db!.db.collection('ushers').doc(b.id).get()).data()!;
    expect(aDoc.acceptedCount).toBe(1);
    expect(bDoc.acceptedCount).toBe(1);
    expect(aDoc.lastScanAt).toBeDefined();
    expect(bDoc.lastScanAt).toBeDefined();
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
