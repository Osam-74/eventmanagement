import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/firebase/admin';
import { requireMomentsAccess, momentsFailure } from '@/lib/api/helpers';
import { r2Configured, r2MissingEnv } from '@/lib/moments/r2';
import { listSlides, startSlideUploads, completeSlideUploads, deleteSlide, signedSlides, MAX_SLIDES } from '@/lib/services/slides';
import { writeAudit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Slideshow settings for one event's guest page. Changing what every guest
 * sees is part of sharing, so this needs the SHARE permission AND access to
 * the event (same guard as the link & QR tab).
 */
const startSchema = z.object({
  action: z.literal('start'),
  files: z.array(z.object({ name: z.string().min(1).max(200), type: z.string().max(100), size: z.number().int().positive() })).min(1).max(20),
});
const completeSchema = z.object({
  action: z.literal('complete'),
  items: z.array(z.object({ id: z.string().min(1).max(40), key: z.string().min(1).max(300), name: z.string().max(200) })).min(1).max(20),
});

export async function GET(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canShareMoments', eventId);
  if ('error' in res) return res.error;
  try {
    const slides = await listSlides(db(), eventId!);
    const signed = r2Configured() ? await signedSlides(slides) : [];
    return NextResponse.json({ ok: true, configured: r2Configured(), missing: r2MissingEnv(), max: MAX_SLIDES, slides: signed });
  } catch (e) { return momentsFailure('slides-list', e); }
}

export async function POST(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canShareMoments', eventId);
  if ('error' in res) return res.error;
  if (!r2Configured()) return NextResponse.json({ ok: false, code: 'STORAGE_NOT_CONFIGURED', message: 'Photo storage (R2) is not connected yet.' }, { status: 503 });
  const body = await req.json().catch(() => null);
  try {
    const s = startSchema.safeParse(body);
    if (s.success) {
      const out = await startSlideUploads(db(), eventId!, s.data.files);
      return NextResponse.json(out.ok ? { ok: true, uploads: out.uploads } : out, { status: out.ok ? 200 : 400 });
    }
    const c = completeSchema.safeParse(body);
    if (c.success) {
      const out = await completeSlideUploads(db(), eventId!, c.data.items);
      if (out.added.length) await writeAudit('MOMENTS_SLIDES_ADDED', res.admin.uid, { eventId, count: out.added.length });
      return NextResponse.json({ ok: true, added: out.added.length, rejected: out.rejected });
    }
    return NextResponse.json({ ok: false, message: 'Bad request' }, { status: 400 });
  } catch (e) { return momentsFailure('slides-write', e); }
}

export async function DELETE(req: NextRequest) {
  const eventId = req.nextUrl.searchParams.get('eventId');
  const res = await requireMomentsAccess(req, 'canShareMoments', eventId);
  if ('error' in res) return res.error;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, message: 'id required' }, { status: 400 });
  try {
    const removed = await deleteSlide(db(), eventId!, id);
    if (removed) await writeAudit('MOMENTS_SLIDE_DELETED', res.admin.uid, { eventId, id });
    return NextResponse.json({ ok: true, removed });
  } catch (e) { return momentsFailure('slides-delete', e); }
}
