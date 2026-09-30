import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, invitationDoc, eventDoc, auditLogsFor, ACTOR } from './helpers';
import { performScan } from '@/lib/services/scan';
import { updateInvitationUsageLimit } from '@/lib/services/invitationAdmin';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

/**
 * Editing a card's scan allowance after generation (owner request
 * 2026-09-28). The QR is untouched, so these prove the end-to-end promise:
 * the SAME token keeps scanning correctly across every kind of edit, the
 * counters stay right, and a racing scan can never be lost or double-counted.
 */
describe.skipIf(!hasEmu)('editing a card scan allowance', () => {
  let usher: { id: string; name: string };
  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    usher = await seedUsher(db!.db, {});
  });
  afterAll(async () => { await db!.cleanup(); });

  const scan = (token: string) =>
    performScan(db!.db, { usherId: usher.id, eventId: EV1, token, clientRequestId: `req-${Math.random().toString(36).slice(2)}` });
  const edit = (digest: string, usageLimit: number | null) =>
    updateInvitationUsageLimit(db!.db, { invitationId: digest, usageLimit, reason: 'test', admin: ACTOR });

  it('INCREASE: a spent single-use card is reopened and the SAME token then admits again', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01001', usageLimit: 1 });
    expect((await scan(inv.token)).code).toBe('ACCEPTED');
    expect((await scan(inv.token)).code).toBe('ALREADY_USED');
    const usedBefore = (await eventDoc(db!.db)).totalUsed;

    const r = await edit(inv.digest, 3);
    expect(r).toMatchObject({ ok: true, status: 'unused', usageCount: 1, usageLimit: 3 });
    expect((await eventDoc(db!.db)).totalUsed).toBe(usedBefore - 1); // reopened => not exhausted any more

    expect((await scan(inv.token)).code).toBe('ACCEPTED'); // 2 of 3
    expect((await scan(inv.token)).code).toBe('ACCEPTED'); // 3 of 3
    expect((await scan(inv.token)).code).toBe('ALREADY_USED');
    expect((await invitationDoc(db!.db, inv.digest)).status).toBe('used');
  });

  it('INCREASE on a fresh card: allowance grows, token unchanged, exact scan count honoured', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01002', usageLimit: 1 });
    await edit(inv.digest, 4);
    for (let i = 1; i <= 4; i++) expect((await scan(inv.token)).usageCount).toBe(i);
    expect((await scan(inv.token)).code).toBe('ALREADY_USED');
  });

  it('REDUCE: lowering a partly-used card takes effect on the very next scan', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01003', usageLimit: 10 });
    await scan(inv.token);
    await scan(inv.token); // 2 used
    expect((await edit(inv.digest, 3)).ok).toBe(true);
    expect((await scan(inv.token)).code).toBe('ACCEPTED'); // 3 of 3
    expect((await scan(inv.token)).code).toBe('ALREADY_USED');
  });

  it('REDUCE to exactly the uses consumed locks the card immediately and counts it exhausted once', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01004', usageLimit: 5 });
    await scan(inv.token);
    await scan(inv.token);
    const before = (await eventDoc(db!.db)).totalUsed;
    const r = await edit(inv.digest, 2);
    expect(r).toMatchObject({ ok: true, status: 'used' });
    expect((await eventDoc(db!.db)).totalUsed).toBe(before + 1);
    expect((await scan(inv.token)).code).toBe('ALREADY_USED');
  });

  it('REFUSES to go below the uses already consumed, and changes nothing', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01005', usageLimit: 10 });
    await scan(inv.token); await scan(inv.token); await scan(inv.token);
    const r = await edit(inv.digest, 2);
    expect(r).toMatchObject({ ok: false, code: 'BELOW_USED' });
    const doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.usageLimit).toBe(10);
    expect(doc.usageCount).toBe(3);
    expect(doc.status).toBe('unused');
  });

  it('UNLIMITED: switching to null admits without a cap; capping again later works', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01006', usageLimit: 1 });
    await scan(inv.token);
    expect((await edit(inv.digest, null)).ok).toBe(true);
    for (let i = 0; i < 6; i++) expect((await scan(inv.token)).code).toBe('ACCEPTED');
    expect((await edit(inv.digest, 7)).ok).toBe(true); // 7 used so far, cap at exactly 7 => locks
    expect((await scan(inv.token)).code).toBe('ALREADY_USED');
  });

  it('a REVOKED card cannot be edited and stays revoked at the gate', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01007', status: 'revoked' });
    expect(await edit(inv.digest, 5)).toMatchObject({ ok: false, code: 'REVOKED' });
    expect((await scan(inv.token)).code).toBe('REVOKED');
  });

  it('unknown card => NOT_FOUND', async () => {
    expect(await edit('nope-nope-nope', 2)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('a LEGACY card with no usageLimit/usageCount fields is edited correctly and migrated', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01008', status: 'used' });
    await db!.db.collection('invitations').doc(inv.digest).update({
      usageLimit: (await import('firebase-admin/firestore')).FieldValue.delete(),
      usageCount: (await import('firebase-admin/firestore')).FieldValue.delete(),
    });
    const r = await edit(inv.digest, 2);
    expect(r).toMatchObject({ ok: true, status: 'unused', usageCount: 1, usageLimit: 2 });
    expect((await scan(inv.token)).code).toBe('ACCEPTED');
    expect((await scan(inv.token)).code).toBe('ALREADY_USED');
  });

  it('same value again is a harmless no-op (no audit noise, no counter drift)', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01009', usageLimit: 3 });
    const auditBefore = (await auditLogsFor(db!.db, 'INVITATION_USAGE_LIMIT_CHANGED')).length;
    const evBefore = await eventDoc(db!.db);
    const r = await edit(inv.digest, 3);
    expect(r).toMatchObject({ ok: true, changed: false });
    expect((await auditLogsFor(db!.db, 'INVITATION_USAGE_LIMIT_CHANGED')).length).toBe(auditBefore);
    expect((await eventDoc(db!.db)).totalUsed).toBe(evBefore.totalUsed);
  });

  it('writes an audit entry recording from/to and the uses at the time', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01010', usageLimit: 2 });
    await scan(inv.token);
    await edit(inv.digest, 6);
    const logs = await auditLogsFor(db!.db, 'INVITATION_USAGE_LIMIT_CHANGED');
    const mine = logs.find((l) => (l as { detail?: { serialNumber?: string } }).detail?.serialNumber === 'ISWED-01010') as
      { detail: { from: number; to: number; usageCount: number } } | undefined;
    expect(mine?.detail).toMatchObject({ from: 2, to: 6, usageCount: 1 });
  });

  it('RACE: many scans fired at the same moment as an edit — never lost, never double-counted, never over the limit', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01011', usageLimit: 20 });
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) ops.push(scan(inv.token));
    ops.push(edit(inv.digest, 15));
    for (let i = 0; i < 12; i++) ops.push(scan(inv.token));
    const settled = await Promise.all(ops);

    const doc = await invitationDoc(db!.db, inv.digest);
    const accepted = settled.filter((o) => (o as { code?: string }).code === 'ACCEPTED').length;
    const editResult = settled[12] as { ok: boolean; code?: string };

    // The count in the database always equals the admissions actually granted.
    expect(doc.usageCount).toBe(accepted);
    if (editResult.ok) {
      expect(doc.usageLimit).toBe(15);
      expect(accepted).toBeLessThanOrEqual(15);
    } else {
      // The only legitimate refusal is "already scanned past the new limit".
      expect(editResult.code).toBe('BELOW_USED');
      expect(doc.usageLimit).toBe(20);
      expect(accepted).toBeLessThanOrEqual(20);
    }
    // Status is consistent with the numbers: locked iff the allowance is used up.
    expect(doc.status).toBe(doc.usageCount >= (doc.usageLimit as number) ? 'used' : 'unused');
  });

  it('an edit aborted by contention is retried and succeeds (no spurious "Could not update")', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01012', usageLimit: 5 });
    // Make the first 2 transactions abort exactly as Firestore does under contention.
    const real = db!.db.runTransaction.bind(db!.db);
    let calls = 0;
    (db!.db as unknown as { runTransaction: unknown }).runTransaction = (fn: never, opts: never) => {
      calls++;
      if (calls <= 2) return Promise.reject(new Error('10 ABORTED: Too much contention on these documents'));
      return real(fn, opts);
    };
    try {
      const r = await edit(inv.digest, 9);
      expect(r).toMatchObject({ ok: true, usageLimit: 9 });
      expect(calls).toBe(3); // two aborted, third committed
      expect((await invitationDoc(db!.db, inv.digest)).usageLimit).toBe(9);
    } finally {
      (db!.db as unknown as { runTransaction: unknown }).runTransaction = real;
    }
  });

  it('a genuinely non-contention failure is NOT retried forever', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-01013', usageLimit: 5 });
    const real = db!.db.runTransaction.bind(db!.db);
    let calls = 0;
    (db!.db as unknown as { runTransaction: unknown }).runTransaction = () => { calls++; return Promise.reject(new Error('PERMISSION_DENIED')); };
    try {
      const r = await edit(inv.digest, 9);
      expect(r).toMatchObject({ ok: false, code: 'ERROR' });
      expect(calls).toBe(1);
    } finally {
      (db!.db as unknown as { runTransaction: unknown }).runTransaction = real;
    }
  });
});
