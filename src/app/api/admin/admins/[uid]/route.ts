import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase/admin';
import { updateAdminSchema } from '@/lib/validation/schemas';
import { badRequest, hasPermission, requirePermission, serverError } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { ALL_PERMISSIONS, type Permission } from '@/lib/types';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  const { uid } = await ctx.params;
  const res = await requirePermission(req, 'canManageAdmins');
  if ('error' in res) return res.error;
  const actor = res.admin;

  const targetSnap = await db().collection('users').doc(uid).get();
  if (!targetSnap.exists) return badRequest('Administrator not found');
  const target = targetSnap.data() as Record<string, unknown>;

  // The ROOT_ADMIN account can only be managed by the ROOT_ADMIN.
  if (target.accountType === 'ROOT_ADMIN' && actor.accountType !== 'ROOT_ADMIN') {
    return badRequest('The Root Admin account cannot be modified by an administrator.');
  }

  const parsed = updateAdminSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { active, displayName, permissions } = parsed.data;

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof active === 'boolean') update.active = active;
  if (displayName) update.displayName = displayName;

  if (permissions) {
    // Anti-escalation: cannot grant a capability the actor does not possess.
    const merged = { ...(target.permissions as Record<string, boolean>) };
    for (const p of ALL_PERMISSIONS) {
      const wants = Boolean((permissions as Record<string, boolean>)[p]);
      if (wants && !hasPermission(actor, p)) continue; // silently drop ungrantable capability
      merged[p] = wants;
    }
    update.permissions = merged;
  }

  await db().collection('users').doc(uid).update(update);
  if (typeof active === 'boolean') {
    await auth().updateUser(uid, { disabled: !active }).catch(() => undefined);
  }

  await writeAudit(active === false ? 'ADMIN_DISABLED' : 'ADMIN_UPDATED', actor.uid, {
    targetUid: uid,
    active,
    displayName,
    permissions: update.permissions ?? undefined,
  });

  return NextResponse.json({ ok: true });
}
