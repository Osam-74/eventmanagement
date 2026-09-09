import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { scanSchema } from '@/lib/validation/schemas';
import { verifyUsherSessionToken } from '@/lib/auth/usherSession';
import { performScan } from '@/lib/services/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const parsed = scanSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'INVALID', message: 'Malformed scan request' }, { status: 200 });
  }
  const { token, clientRequestId, gateId, deviceInfo } = parsed.data;

  const session = verifyUsherSessionToken(req.cookies.get('usher_session')?.value);
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Session expired. Sign in again.' }, { status: 401 });
  }

  try {
    const outcome = await performScan(db(), {
      usherId: session.usherId,
      eventId: session.eventId,
      token,
      clientRequestId,
      gateId: gateId ?? null,
      deviceInfo: deviceInfo ?? null,
    });

    return NextResponse.json(
      { ok: outcome.code === 'ACCEPTED', ...outcome },
      { status: outcome.code === 'UNAUTHORIZED' ? 401 : 200 }
    );
  } catch (e) {
    console.error('scan error', (e as Error).message);
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: 'Could not validate invitation. Try again.' },
      { status: 200 }
    );
  }
}
