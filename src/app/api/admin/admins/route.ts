import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase/admin';
import { createAdminSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { createAdminAccount } from '@/lib/services/admins';

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

  const parsed = createAdminSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Invalid input' }, { status: 400 });
  const { email, password, displayName, permissions } = parsed.data;

  const result = await createAdminAccount(db(), {
    actor: {
      uid: res.admin.uid,
      email: res.admin.email,
      displayName: res.admin.displayName,
      accountType: res.admin.accountType,
      permissions: res.admin.permissions,
    },
    email,
    displayName,
    permissions,
    createAuthUser: async (em, dn) => {
      const user = await auth().createUser({ email: em, password, displayName: dn, emailVerified: true });
      return user.uid;
    },
    setAdminClaim: async (uid) => {
      await auth().setCustomUserClaims(uid, { admin: true });
    },
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: result.code === 'FORBIDDEN' ? 403 : 400 });
  }
  return NextResponse.json({ ok: true, uid: result.uid });
}
