import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dashboard widget: event summary — the LIGHT minimum needed for the
 * dashboard shell (name, date, lifecycle, scanning state + counter totals).
 * ONE Firestore read. Loaded first so the shell paints fast; heavier
 * widgets (activity, ushers, batches) load independently.
 */
export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canViewAnalytics');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';
  if (!eventId) return NextResponse.json({ ok: false, code: 'SERVER_ERROR', message: 'eventId is required' }, { status: 400 });

  const eventSnap = await db().collection('events').doc(eventId).get();
  if (!eventSnap.exists) return NextResponse.json({ ok: true, event: null });
  const event = eventSnap.data()!;

  return NextResponse.json({
    ok: true,
    event: {
      id: eventId,
      name: event.name,
      eventDate: event.eventDate?.toDate?.()?.toISOString?.() ?? null,
      lifecycleStatus: event.lifecycleStatus,
      scanningEnabled: event.scanningEnabled === true,
      scanningEnabledAt: event.scanningEnabledAt?.toDate?.()?.toISOString?.() ?? null,
      scanningEnabledBy: event.scanningEnabledBy ?? null,
      totals: {
        generated: event.totalGenerated ?? 0,
        used: event.totalUsed ?? 0,
        revoked: event.totalRevoked ?? 0,
        unused: Math.max((event.totalGenerated ?? 0) - (event.totalUsed ?? 0) - (event.totalRevoked ?? 0), 0),
        rescansAllowed: event.rescanAllowedCount ?? 0,
        // Total admissions across ALL scans, including repeat scans of one
        // multi-use card (owner request, 2026-09-10) — distinct from `used`,
        // which only counts cards that became fully exhausted. Events from
        // before this field existed had only single-use cards, where every
        // admission WAS an exhaustion, so totalUsed is the exact right
        // fallback for them.
        checkIns: event.totalCheckIns ?? event.totalUsed ?? 0,
      },
    },
  });
}
