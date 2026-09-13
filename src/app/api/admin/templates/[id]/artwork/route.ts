import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Streams the RAW uploaded master artwork (no QR/box/label/serial drawn) —
 * used as the background image in the Modify position editor (owner
 * request, 2026-09-13). Deliberately not the rendered /preview image: the
 * editor draws its own lightweight draggable overlay on top of this, so it
 * needs the plain artwork, not a sharp-rendered composite.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const snap = await db().collection('templates').doc(id).get();
  if (!snap.exists) return NextResponse.json({ ok: false, message: 'Template not found' }, { status: 404 });
  const storagePath = snap.data()!.storagePath as string;

  let buffer: Buffer;
  try {
    [buffer] = await bucket().file(storagePath).download();
  } catch {
    return NextResponse.json({ ok: false, message: 'Could not load template artwork.' }, { status: 500 });
  }

  const ext = storagePath.split('.').pop()?.toLowerCase();
  const contentType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=300' },
  });
}
