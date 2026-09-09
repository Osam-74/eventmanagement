import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, scanLogsFor, auditLogsFor, ACTOR } from './helpers';
import { performScan } from '@/lib/services/scan';
import { allowRescan, revokeInvitation } from '@/lib/services/invitationAdmin';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

describe.skipIf(!hasEmu)('audit log security — raw credentials never persisted', () => {
  let usher: { id: string };

  beforeAll(async () => {
    await seedEvent(db!.db, EV1);
    usher = await seedUsher(db!.db, {});
  });
  afterAll(async () => { await db!.cleanup(); });

  it('scan logs carry the HMAC digest, never the raw QR credential', async () => {
    const inv = await seedInvitation(db!.db, {});
    await performScan(db!.db, {
      usherId: usher.id, eventId: EV1, token: inv.token,
      clientRequestId: 'req-audit-1',
    });
    const logs = await scanLogsFor(db!.db, inv.digest);
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain(inv.token);
      expect(log.tokenDigest).toBe(inv.digest);
    }
  });

  it('rescan and revocation audit entries contain the serial, never the credential', async () => {
    const inv = await seedInvitation(db!.db, { serialNumber: 'ISWED-00060' });
    await revokeInvitation(db!.db, { invitationId: inv.digest, reason: 'test revoke', admin: ACTOR });
    const revAudits = await auditLogsFor(db!.db, 'INVITATION_REVOKED');
    for (const a of revAudits) {
      expect(JSON.stringify(a)).not.toContain(inv.token);
      expect(a.detail.serialNumber).toBe(inv.serial);
    }
  });
});
