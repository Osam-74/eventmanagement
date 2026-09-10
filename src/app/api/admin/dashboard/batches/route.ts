import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dashboard widget: latest 5 batches for the event. Loads independently —
 * a Firestore hiccup here shows one retry card, never a broken dashboard.
 */
export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canViewAnalytics');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';
  if (!eventId) return NextResponse.json({ ok: false, code: 'SERVER_ERROR', message: 'eventId is required' }, { status: 400 });

  const batchesSnap = await db().collection('batches').where('eventId', '==', eventId).orderBy('createdAt', 'desc').limit(5).get();
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

  return NextResponse.json({ ok: true, batches });
}
