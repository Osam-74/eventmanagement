import { afterAll, describe, expect, it } from 'vitest';
import { makeDb, ACTOR, ROOT_ACTOR } from './helpers';
import { deleteAdminAccount } from '@/lib/services/admins';
import { emptyPermissions } from '@/lib/api/helpers';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

/**
 * Owner request (2026-09-10): the Root Admin (or a granted admin) must be
 * able to permanently delete another administrator, not just disable them.
 * Same Root-protection posture as updateAdminAccount, plus: nobody can
 * delete their OWN account through this path.
 */
describe.skipIf(!hasEmu)('administrator deletion', () => {
  afterAll(async () => { await db!.cleanup(); });

  it('admin WITHOUT canManageAdmins cannot delete an administrator', async () => {
    await db!.db.collection('users').doc('victim-1').set({
      email: 'v1@test.local', displayName: 'Victim One', accountType: 'ADMIN',
      active: true, permissions: emptyPermissions(),
    });
    const weak = { ...ACTOR, uid: 'weak', permissions: { ...emptyPermissions(), canViewAnalytics: true } };
    const res = await deleteAdminAccount(db!.db, { actor: weak, targetUid: 'victim-1' });
    expect(res.ok).toBe(false);
    expect((await db!.db.collection('users').doc('victim-1').get()).exists).toBe(true);
  });

  it('nobody can delete their own account', async () => {
    const res = await deleteAdminAccount(db!.db, { actor: ROOT_ACTOR, targetUid: ROOT_ACTOR.uid });
    expect(res.ok).toBe(false);
  });

  it('the Root Admin account can never be deleted, even by itself or another admin', async () => {
    await db!.db.collection('users').doc('root-uid').set({
      email: 'root@test.local', displayName: 'Root', accountType: 'ROOT_ADMIN',
      active: true, permissions: emptyPermissions(),
    });
    const admin = { ...ACTOR, uid: 'some-admin', permissions: { ...emptyPermissions(), canManageAdmins: true } };
    const res = await deleteAdminAccount(db!.db, { actor: admin, targetUid: 'root-uid' });
    expect(res.ok).toBe(false);
    expect((await db!.db.collection('users').doc('root-uid').get()).exists).toBe(true);
  });

  it('returns NOT_FOUND for a non-existent target', async () => {
    const res = await deleteAdminAccount(db!.db, { actor: ROOT_ACTOR, targetUid: 'does-not-exist' });
    expect(res.ok).toBe(false);
  });

  it('a permitted admin can permanently delete a regular administrator, and it writes an audit log', async () => {
    await db!.db.collection('users').doc('victim-2').set({
      email: 'v2@test.local', displayName: 'Victim Two', accountType: 'ADMIN',
      active: true, permissions: emptyPermissions(),
    });
    const admin = { ...ACTOR, uid: 'deleter', permissions: { ...emptyPermissions(), canManageAdmins: true } };
    const res = await deleteAdminAccount(db!.db, { actor: admin, targetUid: 'victim-2' });
    expect(res.ok).toBe(true);
    expect((await db!.db.collection('users').doc('victim-2').get()).exists).toBe(false);

    const audit = await db!.db.collection('auditLogs').where('action', '==', 'ADMIN_DELETED').get();
    expect(audit.docs.some((d) => d.data().detail.targetUid === 'victim-2')).toBe(true);
  });
});
