import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { usherSigninSchema } from '@/lib/validation/schemas';
import { USHER_SESSION_COOKIE, USHER_SESSION_MAX_AGE, createUsherSessionToken } from '@/lib/auth/usherSession';
import { pinVerifier } from '@/lib/auth/pin';
import { safeEqual } from '@/lib/qr/digest';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export async function POST(req: NextRequest) {
  const parsed = usherSigninSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: 'Invalid sign-in details.' }, { status: 400 });
  }
  const { eventId, name, pin } = parsed.data;
  const normalizedName = name.trim().toLowerCase();

  const snap = await db()
    .collection('ushers')
    .where('eventId', '==', eventId)
    .where('normalizedName', '==', normalizedName)
    .limit(1)
    .get();
  const usherDoc = snap.docs[0];
  if (!usherDoc) {
    return NextResponse.json({ ok: false, message: 'Invalid name or PIN.' }, { status: 401 });
  }
  const ref = usherDoc.ref;
  const data = usherDoc.data();

  if (data.active !== true) {
    return NextResponse.json({ ok: false, message: 'This usher access is disabled. See an administrator.' }, { status: 403 });
  }

  const lockedUntil = data.lockedUntil as Timestamp | null;
  if (lockedUntil && lockedUntil.toMillis() > Date.now()) {
    const mins = Math.ceil((lockedUntil.toMillis() - Date.now()) / 60000);
    return NextResponse.json(
      { ok: false, message: `Too many failed attempts. Try again in ~${mins} minute(s).` },
      { status: 429 }
    );
  }

  const expected = data.pinVerifier as string;
  const actual = pinVerifier(usherDoc.id, pin);
  if (!safeEqual(expected, actual)) {
    const failedAttempts = ((data.failedAttempts as number) ?? 0) + 1;
    const update: Record<string, unknown> = { failedAttempts, updatedAt: FieldValue.serverTimestamp() };
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = Timestamp.fromMillis(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      update.failedAttempts = 0;
    }
    await ref.update(update);
    return NextResponse.json({ ok: false, message: 'Invalid name or PIN.' }, { status: 401 });
  }

  // success
  await ref.update({
    failedAttempts: 0,
    lockedUntil: null,
    lastSeenAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const token = createUsherSessionToken({ usherId: usherDoc.id, usherName: data.name as string, eventId });
  const res = NextResponse.json({ ok: true, usherName: data.name, eventId });
  res.cookies.set(USHER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: USHER_SESSION_MAX_AGE,
  });
  return res;
}
