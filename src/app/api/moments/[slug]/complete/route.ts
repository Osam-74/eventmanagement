import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { momentsCompleteSchema } from '@/lib/validation/schemas';
import { resolveEventBySlug, completeUpload } from '@/lib/services/moments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const parsed = momentsCompleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Bad request.' }, { status: 400 });
  const event = await resolveEventBySlug(db(), slug);
  if (!event) return NextResponse.json({ ok: false, message: 'This upload link is not valid.' }, { status: 404 });

  const r = await completeUpload(db(), { eventId: event.id, guestId: parsed.data.guestId, momentId: parsed.data.momentId, parts: parsed.data.parts });
  if (!r.ok) return NextResponse.json({ ok: false, code: r.code, message: r.message }, { status: r.code === 'ERROR' ? 500 : 400 });
  return NextResponse.json({ ok: true, momentId: r.momentId, kind: r.kind, previewUrl: r.previewUrl });
}
