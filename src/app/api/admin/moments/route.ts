import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import { listMoments, deleteMoments } from '@/lib/services/moments';
import { momentsIdsSchema } from '@/lib/validation/schemas';
import { writeAudit } from '@/lib/audit';
import { r2Configured, r2MissingEnv } from '@/lib/moments/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?eventId=…&after=…  -> one page of ready media for an event. */
export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;
  const eventId = req.nextUrl.searchParams.get('eventId');
  if (!eventId) return NextResponse.json({ ok: false, message: 'eventId required' }, { status: 400 });
  const out = await listMoments(db(), { eventId, limit: 48, after: req.nextUrl.searchParams.get('after') });
  // The event's slug builds the public guest link shown on the admin page.
  const ev = await db().collection('events').doc(eventId).get();
  return NextResponse.json({
    ok: true, configured: r2Configured(), missing: r2MissingEnv(),
    slug: (ev.data()?.slug as string | undefined) ?? null, ...out,
  });
}

/** DELETE { ids } (with ?eventId=) -> permanently removes media from R2 and the index. */
export async function DELETE(req: NextRequest) {
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;
  const eventId = req.nextUrl.searchParams.get('eventId');
  const parsed = momentsIdsSchema.safeParse(await req.json().catch(() => null));
  if (!eventId || !parsed.success) return NextResponse.json({ ok: false, message: 'Bad request' }, { status: 400 });
  const removed = await deleteMoments(db(), eventId, parsed.data.ids);
  await writeAudit('MOMENTS_DELETED', res.admin.uid, { eventId, count: removed });
  return NextResponse.json({ ok: true, removed });
}
