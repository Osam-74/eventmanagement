import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase/admin';
import { updateAdminSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { updateAdminAccount, deleteAdminAccount } from '@/lib/services/admins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  const { uid } = await ctx.params;
  const res = await requirePermission(req, 'canManageAdmins');
  if ('error' in res) return res.error;

  const parsed = updateAdminSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Invalid input' }, { status: 400 });
  const { active, displayName, permissions } = parsed.data;

  const result = await updateAdminAccount(db(), {
    actor: {
      uid: res.admin.uid,
      email: res.admin.email,
      displayName: res.admin.displayName,
      accountType: res.admin.accountType,
      permissions: res.admin.permissions,
    },
    targetUid: uid,
    active,
    displayName,
    permissions,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: result.code === 'FORBIDDEN' ? 403 : 400 });
  }

  if (typeof active === 'boolean') {
    await auth().updateUser(uid, { disabled: !active }).catch(() => undefined);
  }

  return NextResponse.json({ ok: true });
}

/** Hard delete — removes the Firebase Auth user and the Firestore users/{uid} record. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ uid: string }> }) {
  const { uid } = await ctx.params;
  const res = await requirePermission(req, 'canManageAdmins');
  if ('error' in res) return res.error;

  const result = await deleteAdminAccount(db(), {
    actor: {
      uid: res.admin.uid,
      email: res.admin.email,
      displayName: res.admin.displayName,
      accountType: res.admin.accountType,
      permissions: res.admin.permissions,
    },
    targetUid: uid,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: result.code === 'FORBIDDEN' ? 403 : result.code === 'NOT_FOUND' ? 404 : 400 });
  }

  await auth().deleteUser(uid).catch(() => undefined);

  return NextResponse.json({ ok: true });
}
