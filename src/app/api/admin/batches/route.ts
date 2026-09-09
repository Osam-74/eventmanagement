import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@/lib/api/helpers';
import { db } from '@/lib/firebase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canGenerateInvites');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';
  const snap = await db()
    .collection('batches')
    .where('eventId', '==', eventId)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
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
