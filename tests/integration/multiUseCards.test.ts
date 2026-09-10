import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, invitationDoc, eventDoc } from './helpers';
import { performScan } from '@/lib/services/scan';
import { allowRescan } from '@/lib/services/invitationAdmin';
import { ACTOR } from './helpers';
import { generateQrToken } from '@/lib/qr/token';
import { digestToken } from '@/lib/qr/digest';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

/**
 * Flexible card generation (owner request, 2026-09-10): a card can allow
 * more than one scan (usageLimit) or be tagged with custom text instead of
 * a serial number (tag). These tests cover the multi-use scan counting and
 * the counters that must stay correct once a card can be admitted more
 * than once — the single-use path is already covered end-to-end by
 * scanFlow.test.ts and countersAndHistory.test.ts and must stay untouched.
 */
describe.skipIf(!hasEmu)('multi-use and tagged cards', () => {
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

  it('a card with usageLimit 3 admits exactly 3 times, then locks', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00200', usageLimit: 3 });

    const out1 = await scan(inv.token);
    expect(out1.code).toBe('ACCEPTED');
    expect(out1.usageCount).toBe(1);
    expect(out1.usageLimit).toBe(3);
    let doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('unused'); // still has allowance left

    const out2 = await scan(inv.token);
    expect(out2.code).toBe('ACCEPTED');
    expect(out2.usageCount).toBe(2);
    doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('unused');

    const out3 = await scan(inv.token);
    expect(out3.code).toBe('ACCEPTED');
    expect(out3.usageCount).toBe(3);
    doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('used'); // exhausted on the 3rd scan

    const out4 = await scan(inv.token);
    expect(out4.code).toBe('ALREADY_USED');
    expect(out4.usageCount).toBe(3);
  });

  it('a card with no usageLimit (unlimited) never locks', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00201', usageLimit: null });
    for (let i = 0; i < 10; i++) {
      const out = await scan(inv.token);
      expect(out.code).toBe('ACCEPTED');
      expect(out.usageLimit).toBeNull();
    }
    const doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('unused');
    expect(doc.usageCount).toBe(10);
  });

  it('a tagged card scans normally and reports its tag on the outcome', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00202', tag: 'FAMILY', usageLimit: 5 });
    const out = await scan(inv.token);
    expect(out.code).toBe('ACCEPTED');
    expect(out.tag).toBe('FAMILY');
    expect(out.serialNumber).toBe('ISWED-00202'); // internal serial still tracked
  });

  it('totalUsed increments once per EXHAUSTED card, not once per scan; totalCheckIns counts every scan', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00203', usageLimit: 5 });
    const before = await eventDoc(db!.db);
    const baselineUsed = before.totalUsed as number;
    const baselineCheckIns = (before.totalCheckIns as number | undefined) ?? 0;

    for (let i = 0; i < 5; i++) await scan(inv.token);

    const after = await eventDoc(db!.db);
    // exactly one exhaustion event for this one card
    expect(after.totalUsed).toBe(baselineUsed + 1);
    // but 5 real admissions happened
    expect(after.totalCheckIns).toBe(baselineCheckIns + 5);
  });

  it('releasing an exhausted multi-use card for rescan gives back exactly one use, not a full reset', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00204', usageLimit: 3 });
    await scan(inv.token);
    await scan(inv.token);
    await scan(inv.token); // now exhausted at 3/3
    let doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('used');
    expect(doc.usageCount).toBe(3);

    await allowRescan(db!.db, { invitationId: inv.digest, reason: 'gate network blip', admin: ACTOR });
    doc = await invitationDoc(db!.db, inv.digest);
    expect(doc.status).toBe('unused');
    expect(doc.usageCount).toBe(2); // one use given back, not reset to 0

    const out = await scan(inv.token);
    expect(out.code).toBe('ACCEPTED');
    expect(out.usageCount).toBe(3);
  });

  it('legacy invitations with no usageLimit/usageCount fields at all behave exactly like a single-use card', async () => {
    // Deliberately writing the raw doc (not via seedInvitation, which now
    // always sets usageLimit) to reproduce every card generated BEFORE this
    // feature shipped — those Firestore docs have no usageLimit/usageCount
    // field whatsoever, not even a stored default.
    const token = generateQrToken();
    const digest = digestToken(token);
    await db!.db.collection('invitations').doc(digest).set({
      eventId: EV1,
      batchId: 'batch-legacy',
      serialNumber: 'ISWED-00205',
      status: 'unused',
      guestAllowance: 1,
      imageStoragePath: 'x',
      outputProfile: 'share',
      generatedAt: new Date(),
      generatedBy: 'admin-x',
      usedAt: null,
      usedAtClientEstimate: null,
      usedByUsherId: null,
      usedByUsherName: null,
      gateId: null,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
      rescanHistory: [],
      rescanAllowedAt: null,
      rescanAllowedBy: null,
      // deliberately NO tag / usageLimit / usageCount / firstUsedAt fields
    });

    const first = await scan(token);
    expect(first.code).toBe('ACCEPTED');
    expect(first.usageLimit).toBe(1); // missing field defaults to single-use
    const doc = await invitationDoc(db!.db, digest);
    expect(doc.status).toBe('used'); // exhausted on its one and only scan, exactly as before this feature

    const second = await scan(token);
    expect(second.code).toBe('ALREADY_USED');
  });
});
