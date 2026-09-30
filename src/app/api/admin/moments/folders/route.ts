import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requireMomentsAccess, momentsFailure } from '@/lib/api/helpers';
import { listGuestFolders } from '@/lib/services/moments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET ?eventId=… -> one folder per guest (count, photos/videos, size). */
export async function GET(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canViewMoments', eventId);
  if ('error' in res) return res.error;
  try {
    const out = await listGuestFolders(db(), eventId!);
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return momentsFailure('folders', e);
  }
}
