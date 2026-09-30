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

  const data = snap.data()!;
  const download = req.nextUrl.searchParams.get('download') === '1';
  const serialNumber = typeof data.serialNumber === 'string' ? data.serialNumber : 'invitation';
  const safeFilename = `${serialNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;

  const [url] = await bucket().file(data.imageStoragePath as string).getSignedUrl({
    action: 'read',
    expires: Date.now() + 10 * 60 * 1000,
    ...(download ? { responseDisposition: `attachment; filename="${safeFilename}"` } : {}),
  });

  if (download) return NextResponse.redirect(url);
  return NextResponse.json({ ok: true, url });
}
