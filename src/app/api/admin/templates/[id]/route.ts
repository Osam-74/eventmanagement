import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import { deleteTemplate } from '@/lib/services/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const result = await deleteTemplate(db(), {
    templateId: id,
    actorUid: res.admin.uid,
    deleteStorageObject: (path) => bucket().file(path).delete().then(() => undefined),
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, message: result.message }, { status: result.code === 'NOT_FOUND' ? 404 : 400 });
  }

  return NextResponse.json({ ok: true });
}
