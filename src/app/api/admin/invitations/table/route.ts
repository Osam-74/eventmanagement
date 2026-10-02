import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { setTableSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { setInvitationTables } from '@/lib/services/invitationTable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Set or clear the table on one or many cards. Database-only: the card image,
 * QR code, tag and scan counters are never touched, so cards already shared
 * keep working exactly as before.
 */
export async function POST(req: NextRequest) {
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = setTableSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: 'Choose at least one card and enter a table.' }, { status: 400 });
  }

  const result = await setInvitationTables(db(), {
    eventId: parsed.data.eventId,
    invitationIds: parsed.data.invitationIds,
    table: parsed.data.table,
    admin: { uid: res.admin.uid, displayName: res.admin.displayName, email: res.admin.email },
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: result.code === 'INVALID' ? 400 : 500 });
  }
  return NextResponse.json({ ok: true, changed: result.changed, unchanged: result.unchanged, skipped: result.skipped });
}
