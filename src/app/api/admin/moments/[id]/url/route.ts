import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requireMomentsAccess } from '@/lib/api/helpers';
import { getMomentsByIds } from '@/lib/services/moments';
import { presignGet } from '@/lib/moments/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Short-lived link to view (or download) one item. Scoped to the given event. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canViewMoments', eventId);
  if ('error' in res) return res.error;
  if (!eventId) return NextResponse.json({ ok: false }, { status: 400 });
  const [item] = await getMomentsByIds(db(), eventId, [id]);
  if (!item) return NextResponse.json({ ok: false, message: 'Not found' }, { status: 404 });
  const download = req.nextUrl.searchParams.get('download') === '1';
  const url = await presignGet(item.key, { contentType: item.contentType, download: download ? item.name : undefined });
  return NextResponse.json({ ok: true, url, kind: item.kind, name: item.name });
}
