import { afterAll, describe, expect, it } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { makeDb } from './helpers';
import { deleteTemplate } from '@/lib/services/templates';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

/**
 * Owner request (2026-09-10): templates should be deletable, like admins.
 * Storage deletion is injected so this test doesn't need a real bucket —
 * only the Firestore rules (existence + in-use guard) are under test here.
 */
describe.skipIf(!hasEmu)('template deletion', () => {
  afterAll(async () => { await db!.cleanup(); });

  it('returns NOT_FOUND for a non-existent template', async () => {
    const res = await deleteTemplate(db!.db, {
      templateId: 'nope', actorUid: 'actor-1', deleteStorageObject: async () => undefined,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('NOT_FOUND');
  });

  it('is blocked while an event still has the template assigned, and names that event', async () => {
    await db!.db.collection('templates').doc('tpl-1').set({
      name: 'Gold Frame', storagePath: 'templates/tpl-1/master.png', createdAt: FieldValue.serverTimestamp(),
    });
    await db!.db.collection('events').doc('ev-1').set({ name: 'I & S Wedding', templateId: 'tpl-1' });

    const res = await deleteTemplate(db!.db, {
      templateId: 'tpl-1', actorUid: 'actor-1', deleteStorageObject: async () => undefined,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('IN_USE');
      expect(res.message).toContain('I & S Wedding');
    }
    expect((await db!.db.collection('templates').doc('tpl-1').get()).exists).toBe(true);
  });

  it('deletes the template, calls Storage deletion, and writes an audit log once unassigned', async () => {
    await db!.db.collection('templates').doc('tpl-2').set({
      name: 'Plain Frame', storagePath: 'templates/tpl-2/master.png', createdAt: FieldValue.serverTimestamp(),
    });

    let deletedPath: string | null = null;
    const res = await deleteTemplate(db!.db, {
      templateId: 'tpl-2',
      actorUid: 'actor-1',
      deleteStorageObject: async (path) => { deletedPath = path; },
    });
    expect(res.ok).toBe(true);
    expect(deletedPath).toBe('templates/tpl-2/master.png');
    expect((await db!.db.collection('templates').doc('tpl-2').get()).exists).toBe(false);

    const audit = await db!.db.collection('auditLogs').where('action', '==', 'TEMPLATE_DELETED').get();
    expect(audit.docs.some((d) => d.data().detail.templateId === 'tpl-2')).toBe(true);
  });
});
