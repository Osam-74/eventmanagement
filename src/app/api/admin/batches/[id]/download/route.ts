import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import archiver from 'archiver';
import { PassThrough } from 'stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Streams a ZIP of all completed invitation cards for a batch.
 * Storage objects are appended as read streams so the ZIP can start flowing
 * to the browser immediately instead of downloading every image into memory
 * one-by-one before each archive entry can be produced.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canGenerateInvites');
  if ('error' in res) return res.error;

  const snap = await db().collection('batches').doc(id).get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, message: 'Batch not found' }, { status: 404 });
  }

  const invitations = await db()
    .collection('invitations')
    .where('batchId', '==', id)
    .orderBy('serialNumber', 'asc')
    .limit(200)
    .get();

  const archive = archiver('zip', { zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);

  for (const doc of invitations.docs) {
    const data = doc.data();
    if (!data.imageStoragePath) continue;
    const fileStream = bucket().file(data.imageStoragePath as string).createReadStream();
    archive.append(fileStream, { name: `${data.serialNumber}.jpg` });
  }

  archive.finalize().catch((e) => archive.destroy(e));

  return new Response(pass as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="batch-${id}.zip"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
