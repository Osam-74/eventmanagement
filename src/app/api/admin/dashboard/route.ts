import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import { Timestamp } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ACTIVE_WINDOW_MS = 90 * 1000;

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canViewAnalytics');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';

  const eventSnap = await db().collection('events').doc(eventId).get();
  if (!eventSnap.exists) return NextResponse.json({ ok: true, dashboard: null });
  const event = eventSnap.data()!;

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

  const scanLogsSnap = await db()
    .collection('scanLogs')
    .where('eventId', '==', eventId)
    .orderBy('scannedAt', 'desc')
    .limit(25)
    .get();
  const recentScans = scanLogsSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      result: data.result,
      serialNumber: data.invitationSerialNumber ?? null,
      usherName: data.usherNameSnapshot ?? null,
      gateId: data.gateId ?? null,
      scannedAt: data.scannedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });

  const acceptedCountSnap = await db()
    .collection('scanLogs')
    .where('eventId', '==', eventId)
    .where('result', '==', 'accepted')
    .count()
    .get();
  const rejectedCountSnap = await db()
    .collection('scanLogs')
    .where('eventId', '==', eventId)
    .where('result', 'in', ['already_used', 'revoked', 'invalid', 'wrong_event', 'scanning_disabled', 'event_closed'])
    .count()
    .get();

  const batchesSnap = await db()
    .collection('batches')
    .where('eventId', '==', eventId)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
  const batches = batchesSnap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      status: data.status,
      requestedQuantity: data.requestedQuantity,
      completedQuantity: data.completedQuantity,
      failedQuantity: data.failedQuantity,
      outputProfile: data.outputProfile,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });

  return NextResponse.json({
    ok: true,
    dashboard: {
      event: {
        id: eventId,
        name: event.name,
        eventDate: event.eventDate?.toDate?.()?.toISOString?.() ?? null,
        lifecycleStatus: event.lifecycleStatus,
        scanningEnabled: event.scanningEnabled === true,
        scanningEnabledAt: event.scanningEnabledAt?.toDate?.()?.toISOString?.() ?? null,
        scanningEnabledBy: event.scanningEnabledBy ?? null,
      },
      totals: {
        generated: event.totalGenerated ?? 0,
        used: event.totalUsed ?? 0,
        revoked: event.totalRevoked ?? 0,
        unused: Math.max((event.totalGenerated ?? 0) - (event.totalUsed ?? 0) - (event.totalRevoked ?? 0), 0),
        rescansAllowed: event.rescanAllowedCount ?? 0,
      },
      scanCounts: {
        accepted: acceptedCountSnap.data().count,
        rejected: rejectedCountSnap.data().count,
      },
      ushers,
      recentScans,
      latestScanAt: recentScans[0]?.scannedAt ?? null,
      batches,
    },
  });
}
