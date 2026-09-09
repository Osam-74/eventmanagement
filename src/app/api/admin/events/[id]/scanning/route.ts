import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { toggleScanningSchema } from '@/lib/validation/schemas';
import { requirePermission } from '@/lib/api/helpers';
import { toggleScanning } from '@/lib/services/scanning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const parsed = toggleScanningSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, message: 'Activation change requires an explicit confirmation and a boolean enabled flag.' },
      { status: 400 }
    );
  const { enabled } = parsed.data;

  const result = await toggleScanning(db(), { eventId: id, enabled, actorUid: res.admin.uid });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: 400 });

  return NextResponse.json({ ok: true, scanningEnabled: result.scanningEnabled });
}
