import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { resolveEventBySlug } from '@/lib/services/moments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public: just the event's display name + whether uploads are open. Nothing else. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const event = await resolveEventBySlug(db(), slug);
  if (!event) return NextResponse.json({ ok: false }, { status: 404 });
  return NextResponse.json({ ok: true, name: event.name, open: event.open });
}
