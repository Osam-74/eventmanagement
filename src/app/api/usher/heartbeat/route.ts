import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { verifyUsherSessionToken } from '@/lib/auth/usherSession';
import { heartbeatSchema } from '@/lib/validation/schemas';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = verifyUsherSessionToken(req.cookies.get('usher_session')?.value);
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });

  const parsed = heartbeatSchema.safeParse(await req.json().catch(() => ({})));
  const gateId = parsed.success ? parsed.data.gateId ?? null : null;

  await db()
    .collection('ushers')
    .doc(session.usherId)
    .update({
      lastSeenAt: FieldValue.serverTimestamp(),
      ...(gateId !== null ? { gateId } : {}),
    });

  const eventSnap = await db().collection('events').doc(session.eventId).get();
  return NextResponse.json({
    ok: true,
    scanningEnabled: eventSnap.data()?.scanningEnabled === true,
  });
}
