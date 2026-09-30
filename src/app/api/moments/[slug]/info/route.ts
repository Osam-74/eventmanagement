import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { resolveEventBySlug } from '@/lib/services/moments';
import { listSlides, signedSlides } from '@/lib/services/slides';
import { r2Configured } from '@/lib/moments/r2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public: the event's display name, whether uploads are open, and the background slide photos (short-lived signed links only). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const event = await resolveEventBySlug(db(), slug);
  if (!event) return NextResponse.json({ ok: false }, { status: 404 });
  // Slides are decoration: if storage hiccups the page must still work, so failures degrade to "no slides".
  let slides: { url: string }[] = [];
  try {
    if (r2Configured()) slides = (await signedSlides(await listSlides(db(), event.id))).map((s) => ({ url: s.url }));
  } catch { slides = []; }
  return NextResponse.json({ ok: true, name: event.name, open: event.open, slides });
}
