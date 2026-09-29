import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { PassThrough, Readable } from 'stream';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import { getAllReadyMoments, getMomentsByIds } from '@/lib/services/moments';
import { getObjectStream } from '@/lib/moments/r2';
import { uniqueZipNames } from '@/lib/moments/rules';
import { momentsIdsSchema } from '@/lib/validation/schemas';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST ?eventId=…  body: { ids: [...] }  -> zip of the SELECTED media
 * POST ?eventId=…&all=1                  -> zip of ALL media for the event
 *
 * Each file is streamed from R2 into the zip one at a time, so memory stays
 * flat no matter how many 100 MB videos there are. Photos/videos are already
 * compressed, so entries are STORED (no re-deflate): faster, less CPU.
 */
export async function POST(req: NextRequest) {
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;
  const eventId = req.nextUrl.searchParams.get('eventId');
  if (!eventId) return NextResponse.json({ ok: false, message: 'eventId required' }, { status: 400 });

  const all = req.nextUrl.searchParams.get('all') === '1';
  let items;
  if (all) {
    items = await getAllReadyMoments(db(), eventId);
  } else {
    const parsed = momentsIdsSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ ok: false, message: 'Select at least one item.' }, { status: 400 });
    items = await getMomentsByIds(db(), eventId, parsed.data.ids);
  }
  if (!items.length) return NextResponse.json({ ok: false, message: 'Nothing to export.' }, { status: 404 });

  await writeAudit('MOMENTS_EXPORTED', res.admin.uid, { eventId, count: items.length, all });

  const names = uniqueZipNames(items.map((i) => i.name));
  const archive = archiver('zip', { store: true });
  const pass = new PassThrough();
  archive.pipe(pass);

  (async () => {
    for (let i = 0; i < items.length; i++) {
      try {
        const body = await getObjectStream(items[i].key);
        archive.append(body as unknown as Readable, { name: names[i] });
        // Wait for this entry to be consumed before opening the next R2
        // stream, so only ONE file is in flight at a time.
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          archive.once('entry', done);
          archive.once('error', done);
        });
      } catch {
        // unreadable object: skip it, keep exporting the rest
      }
    }
    await archive.finalize();
  })().catch((e) => archive.destroy(e));

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(Readable.toWeb(pass) as unknown as ReadableStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="moments-${all ? 'all' : 'selected'}-${stamp}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
}
