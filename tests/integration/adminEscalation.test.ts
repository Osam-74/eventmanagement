import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { makeDb, ACTOR, ROOT_ACTOR } from './helpers';
import { createAdminAccount, updateAdminAccount, grantablePermissions } from '@/lib/services/admins';
import { emptyPermissions } from '@/lib/api/helpers';

const hasEmu = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const db = hasEmu ? makeDb() : null;

describe.skipIf(!hasEmu)('administrator privilege escalation', () => {
  beforeAll(async () => {});
  afterAll(async () => { await db!.cleanup(); });

  const fakeCreate = async (email: string) => `uid-${email.replace(/[^a-z]/g, '')}`;

  it('admin WITHOUT canManageAdmins cannot create or update administrators', async () => {
    const weak = { ...ACTOR, uid: 'weak', permissions: { ...emptyPermissions(), canViewAnalytics: true } };
    const created = await createAdminAccount(db!.db, {
      actor: weak, email: 'new@test.local', displayName: 'New',
      permissions: { canManageAdmins: true }, createAuthUser: fakeCreate,
    });
    expect(created.ok).toBe(false);
    const updated = await updateAdminAccount(db!.db, {
      actor: weak, targetUid: 'someone', active: false,
    });
    expect(updated.ok).toBe(false);
  });

  it('canManageAdmins holder still cannot grant capabilities they lack', async () => {
    // actor has canManageAdmins + canManageUshers only
    const actor = {
      ...ACTOR,
      uid: 'half-actor',
      permissions: { ...emptyPermissions(), canManageAdmins: true, canManageUshers: true },
    };
    const res = await createAdminAccount(db!.db, {
      actor, email: 'new2@test.local', displayName: 'New Two',
      permissions: { canManageAdmins: true, canGenerateInvites: true, canManageUshers: true },
      createAuthUser: fakeCreate,
    });
    expect(res.ok).toBe(true);
    const doc = (await db!.db.collection('users').doc(res.uid!).get()).data()!;
    expect(doc.accountType).toBe('ADMIN');
    expect(doc.permissions.canManageAdmins).toBe(true);   // actor has it → granted
    expect(doc.permissions.canManageUshers).toBe(true);    // actor has it → granted
    expect(doc.permissions.canGenerateInvites).toBe(false); // actor LACKS it → dropped
  });

  it('the created admin can never be a Root Admin (no API path to ROOT_ADMIN)', async () => {
    const res = await createAdminAccount(db!.db, {
      actor: ROOT_ACTOR, email: 'sub@test.local', displayName: 'Sub Admin',
      // even a caller trying to smuggle accountType has no parameter for it
      permissions: { canViewAnalytics: true },
      createAuthUser: fakeCreate,
    } as never);
    expect(res.ok).toBe(true);
    const doc = (await db!.db.collection('users').doc(res.uid!).get()).data()!;
    expect(doc.accountType).toBe('ADMIN');
  });

  it('non-root admin cannot modify the Root Admin account', async () => {
    await db!.db.collection('users').doc('root-uid').set({
      email: 'root@test.local', displayName: 'Root', accountType: 'ROOT_ADMIN',
      active: true, permissions: emptyPermissions(),
    });
    const res = await updateAdminAccount(db!.db, {
      actor: ACTOR, targetUid: 'root-uid', active: false,
    });
    expect(res.ok).toBe(false);
    const doc = (await db!.db.collection('users').doc('root-uid').get()).data()!;
    expect(doc.active).toBe(true); // untouched
  });

  it('updating an admin cannot grant capabilities the actor lacks', async () => {
    await db!.db.collection('users').doc('target-uid').set({
      email: 'target@test.local', displayName: 'Target', accountType: 'ADMIN',
      active: true, permissions: emptyPermissions(),
    });
    const actor = {
      ...ACTOR, uid: 'usher-only',
      permissions: { ...emptyPermissions(), canManageAdmins: true, canManageUshers: true },
    };
    const res = await updateAdminAccount(db!.db, {
      actor, targetUid: 'target-uid',
      permissions: { canGenerateInvites: true, canManageUshers: true },
    });
    expect(res.ok).toBe(true);
    const doc = (await db!.db.collection('users').doc('target-uid').get()).data()!;
    expect(doc.permissions.canGenerateInvites).toBe(false); // escalation blocked
    expect(doc.permissions.canManageUshers).toBe(true);
  });

  it('root admin can manage everything (sanity check of legitimate use)', async () => {
    await db!.db.collection('users').doc('target2-uid').set({
      email: 't2@test.local', displayName: 'T2', accountType: 'ADMIN',
      active: true, permissions: emptyPermissions(),
    });
    const res = await updateAdminAccount(db!.db, {
      actor: ROOT_ACTOR, targetUid: 'target2-uid',
      permissions: { canGenerateInvites: true },
    });
    expect(res.ok).toBe(true);
    const doc = (await db!.db.collection('users').doc('target2-uid').get()).data()!;
    expect(doc.permissions.canGenerateInvites).toBe(true);
  });
});
