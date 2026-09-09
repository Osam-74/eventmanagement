import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { verifyUsherSessionToken } from '@/lib/auth/usherSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = verifyUsherSessionToken(req.cookies.get('usher_session')?.value);
  if (!session) return NextResponse.json({ ok: false, session: null }, { status: 401 });

  const usherSnap = await db().collection('ushers').doc(session.usherId).get();
  if (!usherSnap.exists || usherSnap.data()?.active !== true) {
    return NextResponse.json({ ok: false, session: null, disabled: true }, { status: 401 });
  }
  const eventSnap = await db().collection('events').doc(session.eventId).get();
  const event = eventSnap.data();

  return NextResponse.json({
    ok: true,
    session: {
      usherName: session.usherName,
      gateId: usherSnap.data()!.gateId ?? null,
      acceptedCount: usherSnap.data()!.acceptedCount ?? 0,
      eventId: session.eventId,
      eventName: event?.name ?? '',
      scanningEnabled: event?.scanningEnabled === true,
      lifecycleStatus: event?.lifecycleStatus ?? null,
    },
  });
}
