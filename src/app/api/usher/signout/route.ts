import { NextResponse } from 'next/server';
import { USHER_SESSION_COOKIE } from '@/lib/auth/usherSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(USHER_SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
  return res;
}
