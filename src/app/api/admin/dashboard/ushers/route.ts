import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import { Timestamp } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIVE_WINDOW_MS = 90 * 1000;

/**
 * Dashboard widget: usher roster (bounded to the first 200, same
 * projection the old dashboard used). Loads independently of the event
 * summary so a slow/failing roster never blocks the dashboard shell.
 */
export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canViewAnalytics');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';
  if (!eventId) return NextResponse.json({ ok: false, code: 'SERVER_ERROR', message: 'eventId is required' }, { status: 400 });

  const ushersSnap = await db().collection('ushers').where('eventId', '==', eventId).limit(200).get();
  const now = Date.now();
  const ushers = ushersSnap.docs.map((d) => {
    const data = d.data();
    const lastSeenMs = data.lastSeenAt instanceof Timestamp ? data.lastSeenAt.toDate().getTime() : 0;
    return {
      id: d.id,
      name: data.name,
      gateId: data.gateId ?? null,
      active: data.active,
      lockedUntil: data.lockedUntil?.toDate?.()?.toISOString?.() ?? null,
      acceptedCount: data.acceptedCount ?? 0,
      lastSeenAt: data.lastSeenAt?.toDate?.()?.toISOString?.() ?? null,
      lastScanAt: data.lastScanAt?.toDate?.()?.toISOString?.() ?? null,
      activeNow: data.active === true && now - lastSeenMs < ACTIVE_WINDOW_MS,
    };
  });

  return NextResponse.json({ ok: true, ushers });
}
