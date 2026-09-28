import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { updateUsageLimitSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { updateInvitationUsageLimit } from '@/lib/services/invitationAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Change how many times an existing card may be scanned (increase, reduce,
 * or unlimited). The card's QR and image are untouched — see
 * updateInvitationUsageLimit for the safety rules.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // id = tokenDigest (document id)
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = updateUsageLimitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, message: 'Enter a whole number from 1 to 9999, or choose unlimited.' },
      { status: 400 }
    );
  }

  const result = await updateInvitationUsageLimit(db(), {
    invitationId: id,
    usageLimit: parsed.data.usageLimit,
    reason: parsed.data.reason,
    admin: { uid: res.admin.uid, displayName: res.admin.displayName, email: res.admin.email },
  });
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return NextResponse.json({ ok: false, message: result.message }, { status });
  }
  return NextResponse.json({
    ok: true,
    serialNumber: result.serialNumber,
    usageCount: result.usageCount,
    usageLimit: result.usageLimit,
    status: result.status,
    changed: result.changed,
  });
}
