import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requireMomentsAccess, momentsFailure } from '@/lib/api/helpers';
import { guestMomentsUrl } from '@/lib/moments/guestLink';
import { listMoments, deleteMoments } from '@/lib/services/moments';
import { momentsIdsSchema } from '@/lib/validation/schemas';
import { writeAudit } from '@/lib/audit';
import { r2Configured, r2MissingEnv } from '@/lib/moments/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?eventId=…&after=…  -> one page of ready media for an event. */
export async function GET(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canViewMoments', eventId);
  if ('error' in res) return res.error;
  if (!eventId) return NextResponse.json({ ok: false, message: 'eventId required' }, { status: 400 });
  try {
    const guest = req.nextUrl.searchParams.get('guest');
    const out = await listMoments(db(), { eventId, limit: 48, after: req.nextUrl.searchParams.get('after'), guestId: guest });
    // The event's slug builds the public guest link shown on the admin page.
    const ev = await db().collection('events').doc(eventId).get();
    const slug = (ev.data()?.slug as string | undefined) ?? null;
    // The share link/QR is its own capability: viewers without canShareMoments
    // can see files but are never handed the link.
    const canShare = res.admin.accountType === 'ROOT_ADMIN' || Boolean(res.admin.permissions?.canShareMoments);
    return NextResponse.json({
      ok: true, configured: r2Configured(), missing: r2MissingEnv(),
      slug: canShare ? slug : null, guestLink: canShare && slug ? guestMomentsUrl(slug) : null, canShare, ...out,
    });
  } catch (e) {
    return momentsFailure('list', e);
  }
}

/** DELETE { ids } (with ?eventId=) -> permanently removes media from R2 and the index. */
export async function DELETE(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canDeleteMoments', eventId);
  if ('error' in res) return res.error;
  const parsed = momentsIdsSchema.safeParse(await req.json().catch(() => null));
  if (!eventId || !parsed.success) return NextResponse.json({ ok: false, message: 'Bad request' }, { status: 400 });
  const removed = await deleteMoments(db(), eventId, parsed.data.ids);
  await writeAudit('MOMENTS_DELETED', res.admin.uid, { eventId, count: removed });
  return NextResponse.json({ ok: true, removed });
}
