import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dashboard widget: scan activity — recent scan window + accepted/rejected
 * counts. All three Firestore queries run in PARALLEL (the old monolithic
 * dashboard route ran them sequentially, multiplying region RTT). The
 * recent window is bounded (default 25, max 100) — never the full log.
 */
export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canViewAnalytics');
  if ('error' in res) return res.error;
  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? '';
  if (!eventId) return NextResponse.json({ ok: false, code: 'SERVER_ERROR', message: 'eventId is required' }, { status: 400 });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '25', 10) || 25, 1), 100);

  const [recentSnap, acceptedCountSnap, rejectedCountSnap] = await Promise.all([
    db().collection('scanLogs').where('eventId', '==', eventId).orderBy('scannedAt', 'desc').limit(limit).get(),
    db().collection('scanLogs').where('eventId', '==', eventId).where('result', '==', 'accepted').count().get(),
    db()
      .collection('scanLogs')
      .where('eventId', '==', eventId)
      .where('result', 'in', ['already_used', 'revoked', 'invalid', 'wrong_event', 'scanning_disabled', 'event_closed'])
      .count()
      .get(),
  ]);

  const recentScans = recentSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      result: data.result,
      serialNumber: data.invitationSerialNumber ?? null,
      tag: data.invitationTag ?? null,
      usageCount: data.usageCountAtScan ?? null,
      usageLimit: data.usageLimitAtScan ?? null,
      invitationId: data.invitationId ?? null,
      usherName: data.usherNameSnapshot ?? null,
      gateId: data.gateId ?? null,
      scannedAt: data.scannedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });

  return NextResponse.json({
    ok: true,
    recentScans,
    scanCounts: {
      accepted: acceptedCountSnap.data().count,
      rejected: rejectedCountSnap.data().count,
    },
    latestScanAt: recentScans[0]?.scannedAt ?? null,
  });
}
