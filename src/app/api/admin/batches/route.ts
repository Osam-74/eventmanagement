import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/helpers';
import { db } from '@/lib/firebase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canGenerateInvites');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';
  let snap;
  try {
    snap = await db()
      .collection('batches')
      .where('eventId', '==', eventId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
  } catch (e) {
    // Surface the real Firestore error to the authenticated admin (it embeds
    // a direct create-index link when a composite index is missing/still
    // building) instead of an opaque 500.
    console.error('batches list failed:', (e as Error).message);
    return NextResponse.json(
      { ok: false, message: (e as Error).message ?? 'Failed to load batches.' },
      { status: 500 }
    );
  }
  const batches = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
      completedAt: data.completedAt?.toDate?.()?.toISOString?.() ?? null,
    };
  });
  return NextResponse.json({ ok: true, batches });
}
