import { NextRequest, NextResponse } from 'next/server';
import { auth, db } from '@/lib/firebase/admin';
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_MAX_AGE, createAdminSessionToken, verifyAdminSessionToken } from '@/lib/auth/adminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * THE authoritative admin login sequence (one path, no alternatives):
 *
 *   Firebase email/password sign-in (client)
 *     → valid ID token sent here
 *       → server verifies the token (revocation-checked)
 *         → server confirms the users/{uid} record is an active admin
 *           → server sets the HttpOnly admin_session cookie
 *             → ONLY THEN does the client redirect to /admin.
 *
 * Any failure returns 401 and the client MUST sign out of Firebase and
 * show an error — a failed sign-in can never later become authenticated UI.
 *
 * GET    → current session state (admin or null) — used by the UI gate.
 * DELETE → explicit logout; clears the cookie.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const idToken = typeof body?.idToken === 'string' ? body.idToken : '';
  if (!idToken) {
    return NextResponse.json({ ok: false, message: 'Sign-in failed.' }, { status: 401 });
  }

  let decoded;
  try {
    decoded = await auth().verifyIdToken(idToken, true);
  } catch {
    return NextResponse.json({ ok: false, message: 'Sign-in failed.' }, { status: 401 });
  }

  const snap = await db().collection('users').doc(decoded.uid).get();
  const data = snap.data();
  if (!snap.exists || data?.active === false) {
    return NextResponse.json({ ok: false, message: 'Sign-in failed.' }, { status: 401 });
  }
  if (data?.accountType !== 'ROOT_ADMIN' && data?.accountType !== 'ADMIN') {
    return NextResponse.json({ ok: false, message: 'Sign-in failed.' }, { status: 401 });
  }

  const res = NextResponse.json({
    ok: true,
    admin: {
      uid: decoded.uid,
      email: String(data.email ?? decoded.email ?? ''),
      displayName: String(data.displayName ?? ''),
      accountType: data.accountType,
      permissions: (data.permissions as Record<string, boolean>) ?? {},
    },
  });
  res.cookies.set(ADMIN_SESSION_COOKIE, createAdminSessionToken(decoded.uid), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE,
  });
  return res;
}

export async function GET(req: NextRequest) {
  const session = verifyAdminSessionToken(req.cookies.get(ADMIN_SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ ok: true, admin: null });

  // Re-validate the admin record on every check — a disabled or deleted
  // admin loses the session immediately.
  const snap = await db().collection('users').doc(session.uid).get();
  const data = snap.data();
  if (!snap.exists || data?.active === false) {
    return NextResponse.json({ ok: true, admin: null });
  }
  if (data?.accountType !== 'ROOT_ADMIN' && data?.accountType !== 'ADMIN') {
    return NextResponse.json({ ok: true, admin: null });
  }

  return NextResponse.json({
    ok: true,
    admin: {
      uid: session.uid,
      email: String(data.email ?? ''),
      displayName: String(data.displayName ?? ''),
      accountType: data.accountType,
      permissions: (data.permissions as Record<string, boolean>) ?? {},
    },
  });
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
