import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { momentsAbortSchema } from '@/lib/validation/schemas';
import { resolveEventBySlug, abortUpload } from '@/lib/services/moments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const parsed = momentsAbortSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
  const event = await resolveEventBySlug(db(), slug);
  if (!event) return NextResponse.json({ ok: false }, { status: 404 });
  await abortUpload(db(), { eventId: event.id, guestId: parsed.data.guestId, momentId: parsed.data.momentId });
  return NextResponse.json({ ok: true });
}
