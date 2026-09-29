import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { makeDb, seedEvent, seedInvitation, seedUsher, EV1, invitationDoc, eventDoc, auditLogsFor, ACTOR } from './helpers';
import { performScan } from '@/lib/services/scan';
import { updateInvitationTag } from '@/lib/services/invitationAdmin';
import { renderInvitationImage } from '@/lib/invitation/render';
import { deriveTemplateGeometry } from '@/lib/invitation/geometry';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;
const W = 1070, H = 1470;

/** In-memory Cloud Storage that records the ORDER of operations. */
function fakeBucket() {
  const files = new Map<string, Buffer>();
  const ops: string[] = [];
  let failNextSave = false;
  const bucket = {
    file: (path: string) => ({
      download: async () => { const b = files.get(path); if (!b) throw new Error(`No such object: ${path}`); return [b]; },
      save: async (buf: Buffer) => { if (failNextSave) { failNextSave = false; throw new Error('storage down'); } files.set(path, buf); ops.push(`save:${path}`); },
      delete: async () => { files.delete(path); ops.push(`delete:${path}`); },
      getSignedUrl: async () => [`https://signed.test/${path}`],
    }),
  };
  return { bucket: bucket as never, files, ops, failNextSave: () => { failNextSave = true; } };
}

async function decode(buf: Buffer) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}

/**
 * Editing the tag printed on an existing card (owner request 2026-09-29):
 * the QR must NOT change. Runs the real retag pipeline + real Firestore.
 */
describe.skipIf(!hasEmu)('editing the tag printed on a card', () => {
  let usher: { id: string };
  let templateBuf: Buffer;
  beforeAll(async () => {
    usher = await seedUsher(db!.db, {});
    templateBuf = await sharp({ create: { width: W, height: H, channels: 3, background: '#16302a' } }).png().toBuffer();
    const g = deriveTemplateGeometry(W, H);
    await db!.db.collection('templates').doc('tpl-1').set({
      storagePath: 'templates/tpl-1.png', canvasWidth: W, canvasHeight: H, qr: g.qr, qrOverride: null, qrBox: null, serial: null,
    });
    await seedEvent(db!.db, EV1, { templateId: 'tpl-1' });
  });
  afterAll(async () => { await db!.cleanup(); });

  const scan = (token: string) =>
    performScan(db!.db, { usherId: usher.id, eventId: EV1, token, clientRequestId: `r-${Math.random().toString(36).slice(2)}` });

  /** Seed an invitation AND a genuinely rendered card image for its real token. */
  async function seedCard(opts: { serial: string; tag?: string | null; status?: 'unused' | 'used' | 'revoked'; usageLimit?: number | null }) {
    const inv = await seedInvitation(db!.db, { serialNumber: opts.serial, tag: opts.tag ?? null, status: opts.status, usageLimit: opts.usageLimit });
    const img = (await renderInvitationImage({
      templateBuffer: templateBuf, geometry: deriveTemplateGeometry(W, H), qrToken: inv.token, serial: opts.tag ?? opts.serial, profile: 'share',
    })).buffer;
    const store = fakeBucket();
    store.files.set('templates/tpl-1.png', templateBuf);
    const path = (await invitationDoc(db!.db, inv.digest)).imageStoragePath as string;
    store.files.set(path, img);
    return { ...inv, store, path, img };
  }
  const edit = (c: { digest: string; store: { bucket: never } }, newTag: string | null) =>
    updateInvitationTag(db!.db, c.store.bucket, { invitationId: c.digest, newTag, reason: 'test', admin: ACTOR });

  it('THE QR NEVER CHANGES: same document id, same token still scans, image QR decodes to the same token', async () => {
    const c = await seedCard({ serial: 'ISWED-02001' });
    const r = await edit(c, 'VIP');
    expect(r).toMatchObject({ ok: true, changed: true, tag: 'VIP', printed: 'VIP' });

    // identical document id => identical token digest => every shared copy still valid
    const doc = await invitationDoc(db!.db, c.digest);
    expect(doc.tag).toBe('VIP');
    expect(doc.serialNumber).toBe('ISWED-02001');
    expect(doc.status).toBe('unused');

    // the stored image is new, and its QR still decodes to the ORIGINAL token
    expect(doc.imageStoragePath).not.toBe(c.path);
    const newImg = c.store.files.get(doc.imageStoragePath as string)!;
    expect(await decode(newImg)).toBe(c.token);

    // and the real scan service still admits that same token
    expect((await scan(c.token)).code).toBe('ACCEPTED');
  });

  it('creates no new invitation and revokes nothing (unlike regenerate)', async () => {
    const before = (await db!.db.collection('invitations').get()).size;
    const c = await seedCard({ serial: 'ISWED-02002' });
    await edit(c, 'FAMILY');
    expect((await db!.db.collection('invitations').get()).size).toBe(before + 1); // only the seeded one
    const doc = await invitationDoc(db!.db, c.digest);
    expect(doc.status).toBe('unused');
    expect(doc.revokedAt).toBeNull();
    expect(doc.supersededByInvitationId).toBeUndefined();
  });

  it('other fields and event counters are untouched', async () => {
    const c = await seedCard({ serial: 'ISWED-02003', usageLimit: 5 });
    const evBefore = await eventDoc(db!.db);
    const docBefore = await invitationDoc(db!.db, c.digest);
    await edit(c, 'TABLE 4');
    const docAfter = await invitationDoc(db!.db, c.digest);
    for (const k of ['usageLimit', 'usageCount', 'status', 'guestAllowance', 'batchId', 'eventId', 'serialNumber', 'outputProfile']) {
      expect(docAfter[k], k).toEqual(docBefore[k]);
    }
    const evAfter = await eventDoc(db!.db);
    for (const k of ['totalGenerated', 'totalUsed', 'totalRevoked']) expect(evAfter[k], k).toBe(evBefore[k]);
  });

  it('the old image is deleted only AFTER the new one is saved (never leaves the card without an image)', async () => {
    const c = await seedCard({ serial: 'ISWED-02004' });
    await edit(c, 'VIP');
    const newPath = (await invitationDoc(db!.db, c.digest)).imageStoragePath as string;
    const saveIdx = c.store.ops.indexOf(`save:${newPath}`);
    const delIdx = c.store.ops.indexOf(`delete:${c.path}`);
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(saveIdx);
    expect(c.store.files.has(c.path)).toBe(false);
    expect(c.store.files.has(newPath)).toBe(true);
  });

  it('a storage failure changes NOTHING: tag, image path and old image all intact', async () => {
    const c = await seedCard({ serial: 'ISWED-02005', tag: 'OLD' });
    c.store.failNextSave();
    const r = await edit(c, 'NEW');
    expect(r).toMatchObject({ ok: false });
    const doc = await invitationDoc(db!.db, c.digest);
    expect(doc.tag).toBe('OLD');
    expect(doc.imageStoragePath).toBe(c.path);
    expect(c.store.files.has(c.path)).toBe(true);
    expect((await scan(c.token)).code).toBe('ACCEPTED'); // still works
  });

  it('works on a card that was ALREADY SCANNED and keeps its used state', async () => {
    const c = await seedCard({ serial: 'ISWED-02006', status: 'used', usageLimit: 1 });
    const r = await edit(c, 'GUEST OF HONOUR');
    expect(r).toMatchObject({ ok: true, changed: true });
    const doc = await invitationDoc(db!.db, c.digest);
    expect(doc).toMatchObject({ status: 'used', tag: 'GUEST OF HONOUR' });
    expect((await scan(c.token)).code).toBe('ALREADY_USED'); // not reopened by a tag edit
  });

  it('refuses a REVOKED card and changes nothing', async () => {
    const c = await seedCard({ serial: 'ISWED-02007', status: 'revoked' });
    const r = await edit(c, 'VIP');
    expect(r).toMatchObject({ ok: false, code: 'REVOKED' });
    expect((await invitationDoc(db!.db, c.digest)).tag).toBeNull();
    expect(c.store.ops.filter((o) => o.startsWith('save:'))).toHaveLength(0);
  });

  it('clearing the tag prints the serial again (and stays the same QR)', async () => {
    const c = await seedCard({ serial: 'ISWED-02008', tag: 'VIP' });
    const r = await edit(c, null);
    expect(r).toMatchObject({ ok: true, changed: true, tag: null, printed: 'ISWED-02008' });
    const doc = await invitationDoc(db!.db, c.digest);
    expect(doc.tag).toBeNull();
    expect(await decode(c.store.files.get(doc.imageStoragePath as string)!)).toBe(c.token);
  });

  it('an unchanged tag is a no-op: no render, no write, no audit entry', async () => {
    const c = await seedCard({ serial: 'ISWED-02009', tag: 'VIP' });
    const auditBefore = (await auditLogsFor(db!.db, 'INVITATION_TAG_CHANGED')).length;
    const r = await edit(c, 'VIP');
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(c.store.ops).toEqual([]);
    expect((await invitationDoc(db!.db, c.digest)).imageStoragePath).toBe(c.path);
    expect((await auditLogsFor(db!.db, 'INVITATION_TAG_CHANGED')).length).toBe(auditBefore);
  });

  it('writes an audit entry recording old and new tag', async () => {
    const c = await seedCard({ serial: 'ISWED-02010', tag: 'AAA' });
    await edit(c, 'BBB');
    const logs = await auditLogsFor(db!.db, 'INVITATION_TAG_CHANGED');
    const mine = logs.find((l) => (l.detail as { invitationId: string }).invitationId === c.digest);
    expect(mine).toBeDefined();
    expect(mine!.detail).toMatchObject({ from: 'AAA', to: 'BBB', serialNumber: 'ISWED-02010' });
    expect(mine!.actor).toBe(ACTOR.uid);
  });

  it('unknown card => NOT_FOUND', async () => {
    const store = fakeBucket();
    const r = await updateInvitationTag(db!.db, store.bucket, { invitationId: 'does-not-exist', newTag: 'X', reason: '', admin: ACTOR });
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('two edits in a row both succeed and the QR still decodes to the same token', async () => {
    const c = await seedCard({ serial: 'ISWED-02011' });
    await edit(c, 'GRANDPARENTS TABLE ONE');
    await edit(c, 'VIP');
    const doc = await invitationDoc(db!.db, c.digest);
    expect(doc.tag).toBe('VIP');
    expect(await decode(c.store.files.get(doc.imageStoragePath as string)!)).toBe(c.token);
    expect((await scan(c.token)).code).toBe('ACCEPTED');
  });
});
