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
  /** Events this admin may open in Guest moments (Root Admin: all, ignores this). */
  momentsEventIds?: string[];
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
 * Which events' moments an actor may open. Root Admin: every event (null =
 * unrestricted). Anyone else: exactly their granted list (default none).
 */
export function accessibleMomentEvents(
  actor: Pick<AdminActor, 'accountType' | 'momentsEventIds'>
): string[] | null {
  if (actor.accountType === 'ROOT_ADMIN') return null;
  return Array.isArray(actor.momentsEventIds) ? actor.momentsEventIds : [];
}

/**
 * Anti-escalation for event access: an actor can only hand out access to
 * events they can access themselves (Root Admin: any). Deduplicated; events
 * the actor cannot see are silently dropped, like ungrantable permissions.
 */
export function grantableMomentEvents(
  actor: Pick<AdminActor, 'accountType' | 'momentsEventIds'>,
  requested: string[] | undefined
): string[] {
  const want = Array.from(new Set(requested ?? []));
  const mine = accessibleMomentEvents(actor);
  return mine === null ? want : want.filter((id) => mine.includes(id));
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
    momentsEventIds?: string[];
    createAuthUser: (email: string, displayName: string) => Promise<string>;
    setAdminClaim?: (uid: string) => Promise<void>;
  }
): Promise<AdminServiceResult & { uid?: string }> {
  const { actor, email, displayName, permissions, createAuthUser, setAdminClaim } = input;
  const momentsEventIds = grantableMomentEvents(actor, input.momentsEventIds);

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
    momentsEventIds,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: actor.uid,
  });

  await setAdminClaim?.(uid);

  await firestore.collection('auditLogs').add({
    action: 'ADMIN_CREATED',
    actor: actor.uid,
    actorType: 'admin',
    detail: { newAdminUid: uid, email, permissions: granted, momentsEventIds },
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
    momentsEventIds?: string[];
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

  if (input.momentsEventIds) {
    // Replace the target's event list, but never let the actor grant events
    // they cannot access, and never strip events they cannot see from the
    // target: keep those the actor has no visibility of, replace the rest.
    const before = Array.isArray(target.momentsEventIds) ? (target.momentsEventIds as string[]) : [];
    const mine = accessibleMomentEvents(actor);
    const invisibleToActor = mine === null ? [] : before.filter((id) => !mine.includes(id));
    update.momentsEventIds = Array.from(new Set([...invisibleToActor, ...grantableMomentEvents(actor, input.momentsEventIds)]));
  }

  await firestore.collection('users').doc(targetUid).update(update);

  // strip undefined values — Firestore rejects undefined field values
  const detail: Record<string, unknown> = { targetUid };
  if (typeof active === 'boolean') detail.active = active;
  if (displayName) detail.displayName = displayName;
  if (update.permissions) detail.permissions = update.permissions;
  if (update.momentsEventIds) detail.momentsEventIds = update.momentsEventIds;

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

/**
 * One-time backfill for the move of Guest moments off `canManageInvites` and
 * onto its own permissions. Every existing ADMIN who could use the feature
 * before (canManageInvites) keeps exactly that ability: they get view + share
 * (+ delete, as they could delete before) and access to every current event.
 * Nobody loses access silently; the owner narrows it afterwards from the
 * Admins page. Idempotent: an admin who already has canViewMoments is skipped,
 * so re-running never overrides a choice the owner made.
 */
export async function backfillMomentsAccess(
  firestore: Firestore,
  opts: { dryRun: boolean }
): Promise<{ updated: string[]; skipped: string[]; eventCount: number }> {
  const events = await firestore.collection('events').get();
  const eventIds = events.docs.filter((d) => d.data().deleted !== true).map((d) => d.id);
  const users = await firestore.collection('users').get();
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const u of users.docs) {
    const d = u.data();
    if (d.accountType !== 'ADMIN') { skipped.push(u.id); continue; } // root already sees everything
    const perms = (d.permissions ?? {}) as Record<string, boolean>;
    if (perms.canViewMoments !== undefined || !perms.canManageInvites) { skipped.push(u.id); continue; }
    updated.push(u.id);
    if (opts.dryRun) continue;
    await u.ref.update({
      'permissions.canViewMoments': true,
      'permissions.canDeleteMoments': true,
      'permissions.canShareMoments': true,
      momentsEventIds: eventIds,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  return { updated, skipped, eventCount: eventIds.length };
}
