import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { regenerateInvitationSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { regenerateInvitationImage } from '@/lib/services/invitationAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // id = tokenDigest (document id) of the BROKEN invitation
  // Rendering + issuing a fresh credential — same permission as batch generation.
  const res = await requirePermission(req, 'canGenerateInvites');
  if ('error' in res) return res.error;

  const parsed = regenerateInvitationSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Invalid input' }, { status: 400 });

  const result = await regenerateInvitationImage(db(), bucket(), {
    invitationId: id,
    reason: parsed.data.reason,
    admin: { uid: res.admin.uid, displayName: res.admin.displayName, email: res.admin.email },
  });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: 400 });
  return NextResponse.json({
    ok: true,
    serialNumber: result.serialNumber,
    newInvitationId: result.newInvitationId,
    imageUrl: result.imageUrl,
  });
}
