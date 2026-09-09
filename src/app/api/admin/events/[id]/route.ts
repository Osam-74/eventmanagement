import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { updateEventSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const parsed = updateEventSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { name, eventDate, lifecycleStatus, templateId } = parsed.data;

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (name) update.name = name;
  if (eventDate) update.eventDate = new Date(eventDate);
  if (lifecycleStatus) update.lifecycleStatus = lifecycleStatus;
  if (templateId !== undefined) update.templateId = templateId;

  await db().collection('events').doc(id).update(update);
  await writeAudit('EVENT_UPDATED', res.admin.uid, { eventId: id, name, eventDate, lifecycleStatus, templateId });

  return NextResponse.json({ ok: true });
}
