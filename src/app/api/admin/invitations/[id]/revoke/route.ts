import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { revokeInvitationSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { revokeInvitation } from '@/lib/services/invitationAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // id = tokenDigest (document id)
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = revokeInvitationSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Invalid input' }, { status: 400 });

  const result = await revokeInvitation(db(), {
    invitationId: id,
    reason: parsed.data.reason,
    admin: { uid: res.admin.uid, displayName: res.admin.displayName, email: res.admin.email },
  });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: 400 });
  return NextResponse.json({ ok: true, serialNumber: result.serialNumber });
}
