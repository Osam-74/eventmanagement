import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { allowRescanSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { allowRescan } from '@/lib/services/invitationAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // id = tokenDigest (document id)
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = allowRescanSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'A reason of at least 3 characters is required.' }, { status: 400 });

  const result = await allowRescan(db(), {
    invitationId: id,
    reason: parsed.data.reason,
    admin: { uid: res.admin.uid, displayName: res.admin.displayName, email: res.admin.email },
  });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: 400 });
  return NextResponse.json({ ok: true, serialNumber: result.serialNumber });
}
