import { NextRequest, NextResponse } from 'next/server';
import { usherSigninSchema } from '@/lib/validation/schemas';
import { usherSignIn } from '@/lib/services/usherAuth';
import { USHER_SESSION_COOKIE, USHER_SESSION_MAX_AGE, createUsherSessionToken } from '@/lib/auth/usherSession';
import { db } from '@/lib/firebase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const parsed = usherSigninSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: 'Invalid sign-in details.' }, { status: 400 });
  }

  const result = await usherSignIn(db(), parsed.data);

  if (!result.ok) {
    const status = result.code === 'LOCKED' ? 429 : result.code === 'DISABLED' ? 403 : 401;
    return NextResponse.json({ ok: false, message: result.message }, { status });
  }

  const token = createUsherSessionToken({
    usherId: result.usher.id,
    usherName: result.usher.name,
    eventId: parsed.data.eventId,
  });
  const res = NextResponse.json({ ok: true, usherName: result.usher.name, eventId: parsed.data.eventId });
  res.cookies.set(USHER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: USHER_SESSION_MAX_AGE,
  });
  return res;
}
