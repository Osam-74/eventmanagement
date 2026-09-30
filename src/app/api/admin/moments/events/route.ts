import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission, momentsFailure } from '@/lib/api/helpers';
import { accessibleMomentEvents } from '@/lib/services/admins';
import { guestMomentsUrl } from '@/lib/moments/guestLink';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET -> the events THIS admin may open in Guest moments, with a count each.
 * Root Admin: every (non-archived) event. Anyone else: only events granted to
 * them. Deliberately NOT built on the global events endpoint, which needs
 * canManageEvents: a moments-only admin must not need (or be shown) that.
 */
export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canViewMoments');
  if ('error' in res) return res.error;

  try {
    const allowed = accessibleMomentEvents(res.admin);
    const snap = await db().collection('events').orderBy('createdAt', 'desc').limit(100).get();
    const canShare = res.admin.accountType === 'ROOT_ADMIN' || Boolean(res.admin.permissions?.canShareMoments);

    const visible = snap.docs.filter((d) => d.data().deleted !== true && (allowed === null || allowed.includes(d.id)));
    const events = await Promise.all(visible.map(async (d) => {
      const data = d.data();
      const count = (await db().collection('moments').where('eventId', '==', d.id).where('status', '==', 'ready').count().get()).data().count;
      const slug = (data.slug as string | undefined) ?? null;
      return {
        id: d.id, name: String(data.name ?? ''), slug: canShare ? slug : null,
        eventDate: data.eventDate?.toDate?.()?.toISOString?.() ?? null,
        count, guestLink: canShare && slug ? guestMomentsUrl(slug) : null,
      };
    }));
    return NextResponse.json({ ok: true, events, canShare });
  } catch (e) {
    return momentsFailure('events', e);
  }
}
