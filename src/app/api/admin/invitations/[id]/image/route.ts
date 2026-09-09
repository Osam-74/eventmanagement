import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const snap = await db().collection('invitations').doc(id).get();
  if (!snap.exists || !snap.data()?.imageStoragePath) {
    return NextResponse.json({ ok: false, message: 'No stored image for this invitation' }, { status: 404 });
  }

  const [url] = await bucket().file(snap.data()!.imageStoragePath as string).getSignedUrl({
    action: 'read',
    expires: Date.now() + 10 * 60 * 1000,
  });
  return NextResponse.json({ ok: true, url });
}
