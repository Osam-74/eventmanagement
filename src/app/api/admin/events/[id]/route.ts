import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { updateEventSchema, permanentlyDeleteEventSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { archiveEvent, permanentlyDeleteEvent } from '@/lib/services/eventLifecycle';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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

/**
 * DELETE = archive (soft delete). Query `?permanent=true` switches to the
 * irreversible cascade delete, which requires a JSON body
 * `{ confirmSlug }` matching the event's slug and only works on an event
 * that is already archived — see eventLifecycle.ts for both paths.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const permanent = new URL(req.url).searchParams.get('permanent') === 'true';

  if (!permanent) {
    const result = await archiveEvent(db(), { eventId: id, actorUid: res.admin.uid });
    if (!result.ok) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status });
    }
    return NextResponse.json({ ok: true });
  }

  const parsed = permanentlyDeleteEventSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Type the event slug to confirm.');

  const result = await permanentlyDeleteEvent(db(), bucket(), {
    eventId: id,
    confirmSlug: parsed.data.confirmSlug,
    actorUid: res.admin.uid,
  });
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status });
  }
  return NextResponse.json({ ok: true, counts: result.counts });
}
