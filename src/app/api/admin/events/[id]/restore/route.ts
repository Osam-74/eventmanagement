import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import { restoreEvent } from '@/lib/services/eventLifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const result = await restoreEvent(db(), { eventId: id, actorUid: res.admin.uid });
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : 400;
    return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status });
  }
  return NextResponse.json({ ok: true });
}
