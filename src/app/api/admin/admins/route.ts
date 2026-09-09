import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase/admin';
import { createAdminSchema } from '@/lib/validation/schemas';
import { badRequest, hasPermission, requirePermission, serverError, emptyPermissions } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { ALL_PERMISSIONS, type Permission } from '@/lib/types';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canManageAdmins');
  if ('error' in res) return res.error;
  const snap = await db().collection('users').orderBy('createdAt', 'desc').limit(200).get();
  const admins = snap.docs.map((d) => ({
    uid: d.id,
    ...(d.data() as Record<string, unknown>),
    createdAt: d.data().createdAt?.toDate?.()?.toISOString?.() ?? null,
  }));
  return NextResponse.json({ ok: true, admins });
}

export async function POST(req: NextRequest) {
  const res = await requirePermission(req, 'canManageAdmins');
  if ('error' in res) return res.error;
  const admin = res.admin;

  const parsed = createAdminSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { email, password, displayName, permissions } = parsed.data;

  // Anti-escalation: can only grant canManageAdmins if you have it yourself.
  const granted: Record<Permission, boolean> = emptyPermissions();
  for (const p of ALL_PERMISSIONS) {
    if (permissions[p as keyof typeof permissions]) {
      if (p === 'canManageAdmins' && !hasPermission(admin, 'canManageAdmins')) continue;
      granted[p] = true;
    }
  }

  let user;
  try {
    user = await auth().createUser({ email, password, displayName, emailVerified: true });
  } catch (e) {
    return badRequest(`Could not create auth user: ${(e as Error).message}`);
  }

  const doc = {
    email,
    displayName,
    accountType: 'ADMIN' as const,
    active: true,
    permissions: granted,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: admin.uid,
  };
  await db().collection('users').doc(user.uid).set(doc);
  await auth().setCustomUserClaims(user.uid, { admin: true });
  await writeAudit('ADMIN_CREATED', admin.uid, { newAdminUid: user.uid, email, permissions: granted });

  return NextResponse.json({ ok: true, uid: user.uid });
}
