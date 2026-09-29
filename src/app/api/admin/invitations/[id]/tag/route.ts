import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { updateTagSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { updateInvitationTag } from '@/lib/services/invitationAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Change the tag printed on an existing card (or clear it to print the
 * serial). The QR code is NOT changed — see updateInvitationTag.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // id = tokenDigest (document id)
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = updateTagSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid tag.' },
      { status: 400 }
    );
  }

  const result = await updateInvitationTag(db(), bucket(), {
    invitationId: id,
    // Printed uppercase, exactly as generation does.
    newTag: parsed.data.tag ? parsed.data.tag.toUpperCase() : null,
    reason: parsed.data.reason,
    admin: { uid: res.admin.uid, displayName: res.admin.displayName, email: res.admin.email },
  });
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === 'ERROR' ? 500 : 400;
    return NextResponse.json({ ok: false, message: result.message }, { status });
  }
  return NextResponse.json({
    ok: true,
    serialNumber: result.serialNumber,
    tag: result.tag,
    printed: result.printed,
    changed: result.changed,
  });
}
