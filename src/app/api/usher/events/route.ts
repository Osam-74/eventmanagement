import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Minimal, unauthenticated list of scannable events for the usher sign-in screen. */
export async function GET() {
  const snap = await db()
    .collection('events')
    .where('lifecycleStatus', 'in', ['draft', 'open'])
    .limit(50)
    .get();
  const events = snap.docs.map((d) => ({ id: d.id, name: d.data().name, slug: d.data().slug }));
  return NextResponse.json({ ok: true, events });
}
