import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { ALL_PERMISSIONS, type Permission } from '@/lib/types';
import { emptyPermissions } from '@/lib/api/helpers';

export type AdminActor = {
  uid: string;
  email: string;
  displayName: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  permissions: Record<string, boolean>;
};

export type AdminServiceResult =
  | { ok: true }
  | { ok: false; code: 'FORBIDDEN' | 'NOT_FOUND' | 'ERROR'; message: string };

export function actorHasPermission(
  actor: Pick<AdminActor, 'accountType' | 'permissions'>,
  p: Permission
): boolean {
  if (actor.accountType === 'ROOT_ADMIN') return true;
  return Boolean(actor.permissions?.[p]);
}

/**
 * Anti-escalation: an actor can only grant capabilities they themselves
 * possess (Root Admin can grant everything). Requested-but-ungrantable
 * capabilities are silently dropped.
 */
export function grantablePermissions(
  actor: Pick<AdminActor, 'accountType' | 'permissions'>,
  requested: Record<string, boolean>
): Record<Permission, boolean> {
  const granted = emptyPermissions();
  for (const p of ALL_PERMISSIONS) {
    if (requested?.[p] && actorHasPermission(actor, p)) granted[p] = true;
  }
  return granted;
}

/**
 * Creates a REGULAR administrator. There is deliberately no parameter for
 * accountType — nobody can create another Root Admin through any API; the
 * single Root Admin is bootstrapped offline by the owner.
 *
 * createAuthUser / setAdminClaim are injected so tests can exercise the
 * authorization rules without Firebase Auth.
 */
export async function createAdminAccount(
  firestore: Firestore,
  input: {
    actor: AdminActor;
    email: string;
    displayName: string;
    permissions: Record<string, boolean>;
    createAuthUser: (email: string, displayName: string) => Promise<string>;
    setAdminClaim?: (uid: string) => Promise<void>;
  }
): Promise<AdminServiceResult & { uid?: string }> {
  const { actor, email, displayName, permissions, createAuthUser, setAdminClaim } = input;

  if (!actorHasPermission(actor, 'canManageAdmins')) {
    return { ok: false, code: 'FORBIDDEN', message: 'Missing permission: canManageAdmins' };
  }

  let uid: string;
  try {
    uid = await createAuthUser(email, displayName);
  } catch {
    return { ok: false, code: 'ERROR', message: 'Could not create auth user' };
  }

  const granted = grantablePermissions(actor, permissions);

  await firestore.collection('users').doc(uid).set({
    email,
    displayName,
    accountType: 'ADMIN', // never ROOT_ADMIN via API
    active: true,
    permissions: granted,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: actor.uid,
  });

  await setAdminClaim?.(uid);

  await firestore.collection('auditLogs').add({
    action: 'ADMIN_CREATED',
    actor: actor.uid,
    actorType: 'admin',
    detail: { newAdminUid: uid, email, permissions: granted },
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true, uid };
}

/**
 * Updates an administrator with Root protection and anti-escalation.
 * accountType can never be changed here.
 */
export async function updateAdminAccount(
  firestore: Firestore,
  input: {
    actor: AdminActor;
    targetUid: string;
    active?: boolean;
    displayName?: string;
    permissions?: Record<string, boolean>;
  }
): Promise<AdminServiceResult> {
  const { actor, targetUid, active, displayName, permissions } = input;

  if (!actorHasPermission(actor, 'canManageAdmins')) {
    return { ok: false, code: 'FORBIDDEN', message: 'Missing permission: canManageAdmins' };
  }

  const targetSnap = await firestore.collection('users').doc(targetUid).get();
  if (!targetSnap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Administrator not found' };
  const target = targetSnap.data() as Record<string, unknown>;

  // The ROOT_ADMIN account can only be managed by the ROOT_ADMIN.
  if (target.accountType === 'ROOT_ADMIN' && actor.accountType !== 'ROOT_ADMIN') {
    return { ok: false, code: 'FORBIDDEN', message: 'The Root Admin account cannot be modified by an administrator.' };
  }

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof active === 'boolean') update.active = active;
  if (displayName) update.displayName = displayName;

  if (permissions) {
    // Partial update: the admins-page UI PATCHes ONE permission at a time
    // (a single checkbox toggle), so only touch keys actually present in
    // this request — anything omitted must keep its existing merged value.
    // (Previously this defaulted every omitted key to `false`, so toggling
    // one permission silently wiped out every other permission already
    // granted — an admin could effectively only ever hold one at a time.)
    const merged = { ...(target.permissions as Record<string, boolean>) };
    for (const p of ALL_PERMISSIONS) {
      if (!(p in permissions)) continue;
      const wants = Boolean(permissions[p]);
      if (wants && !actorHasPermission(actor, p)) continue; // anti-escalation
      merged[p] = wants;
    }
    update.permissions = merged;
  }

  await firestore.collection('users').doc(targetUid).update(update);

  // strip undefined values — Firestore rejects undefined field values
  const detail: Record<string, unknown> = { targetUid };
  if (typeof active === 'boolean') detail.active = active;
  if (displayName) detail.displayName = displayName;
  if (update.permissions) detail.permissions = update.permissions;

  await firestore.collection('auditLogs').add({
    action: active === false ? 'ADMIN_DISABLED' : 'ADMIN_UPDATED',
    actor: actor.uid,
    actorType: 'admin',
    detail,
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true };
}

/**
 * Hard delete: removes the users/{uid} record entirely (the Firebase Auth
 * user is deleted by the caller — see the route — since that's an Auth SDK
 * call, not a Firestore one). Same Root-protection as updateAdminAccount,
 * plus: an admin (or the Root Admin) can never delete their OWN account
 * through this endpoint — that would either strand the last admin able to
 * manage admins or lock the Root Admin out of their own bootstrap identity.
 */
export async function deleteAdminAccount(
  firestore: Firestore,
  input: { actor: AdminActor; targetUid: string }
): Promise<AdminServiceResult> {
  const { actor, targetUid } = input;

  if (!actorHasPermission(actor, 'canManageAdmins')) {
    return { ok: false, code: 'FORBIDDEN', message: 'Missing permission: canManageAdmins' };
  }
  if (targetUid === actor.uid) {
    return { ok: false, code: 'FORBIDDEN', message: 'You cannot delete your own account.' };
  }

  const targetSnap = await firestore.collection('users').doc(targetUid).get();
  if (!targetSnap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Administrator not found' };
  const target = targetSnap.data() as Record<string, unknown>;

  if (target.accountType === 'ROOT_ADMIN') {
    return { ok: false, code: 'FORBIDDEN', message: 'The Root Admin account can never be deleted.' };
  }

  await firestore.collection('users').doc(targetUid).delete();

  await firestore.collection('auditLogs').add({
    action: 'ADMIN_DELETED',
    actor: actor.uid,
    actorType: 'admin',
    detail: { targetUid, email: target.email, displayName: target.displayName },
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true };
}
