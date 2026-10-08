import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/firebase/admin';
import { requireMomentsAccess, momentsFailure } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Switch an event's public guest upload link live or off.
 * Deactivating never deletes anything: the link, QR and every uploaded photo
 * stay as they are; guests just see "Uploads are closed" until it is turned
 * back on. Same guard as the Link & QR tab (share permission + event access).
 */
const schema = z.object({ enabled: z.boolean() });

export async function PATCH(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canShareMoments', eventId);
  if ('error' in res) return res.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Bad request' }, { status: 400 });
  try {
    const ref = db().collection('events').doc(eventId!);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.deleted === true) return NextResponse.json({ ok: false, message: 'Event not found.' }, { status: 404 });
    await ref.update({ momentsGuestLinkEnabled: parsed.data.enabled });
    await writeAudit('MOMENTS_GUEST_LINK_TOGGLED', res.admin.uid, { eventId, enabled: parsed.data.enabled });
    return NextResponse.json({ ok: true, enabled: parsed.data.enabled });
  } catch (e) { return momentsFailure('link-toggle', e); }
}
