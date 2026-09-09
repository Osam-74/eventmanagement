import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { toggleScanningSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const parsed = toggleScanningSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return badRequest('Activation change requires an explicit confirmation and a boolean enabled flag.');
  const { enabled } = parsed.data;

  const ref = db().collection('events').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('Event not found');
  const event = snap.data()!;

  // Closing/archiving an event also stops scanning.
  const lifecycleStatus = event.lifecycleStatus as string;
  const effective = enabled && lifecycleStatus !== 'closed' && lifecycleStatus !== 'archived';

  await ref.update({
    scanningEnabled: effective,
    scanningEnabledAt: FieldValue.serverTimestamp(),
    scanningEnabledBy: res.admin.uid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAudit('SCANNING_TOGGLED', res.admin.uid, {
    eventId: id,
    enabled: effective,
    requestedEnabled: enabled,
  });

  return NextResponse.json({ ok: true, scanningEnabled: effective });
}
