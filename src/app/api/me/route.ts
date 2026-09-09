import { NextRequest, NextResponse } from 'next/server';
import { getAdminContext } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const admin = await getAdminContext(req);
  if (!admin) return NextResponse.json({ ok: true, admin: null });
  return NextResponse.json({ ok: true, admin });
}
