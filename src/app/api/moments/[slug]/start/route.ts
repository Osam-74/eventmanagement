import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { momentsStartSchema } from '@/lib/validation/schemas';
import { resolveEventBySlug, startUploads } from '@/lib/services/moments';
import { r2Configured } from '@/lib/moments/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PUBLIC (no sign-in): guests get short-lived upload links for one event. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!r2Configured()) return NextResponse.json({ ok: false, message: 'Uploads are not available right now.' }, { status: 503 });

  const parsed = momentsStartSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: 'Please choose photos or videos up to 100 MB each.' }, { status: 400 });

  const event = await resolveEventBySlug(db(), slug);
  if (!event) return NextResponse.json({ ok: false, message: 'This upload link is not valid.' }, { status: 404 });
  if (!event.open) return NextResponse.json({ ok: false, message: 'Uploads are closed for this event.' }, { status: 403 });

  const out = await startUploads(db(), { eventId: event.id, guestId: parsed.data.guestId, files: parsed.data.files });
  if (!out.ok) return NextResponse.json({ ok: false, message: out.message }, { status: 400 });
  return NextResponse.json({ ok: true, uploads: out.uploads });
}
