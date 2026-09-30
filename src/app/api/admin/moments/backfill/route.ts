import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { getAdminContext, unauthorized, forbidden } from '@/lib/api/helpers';
import { backfillMomentsAccess } from '@/lib/services/admins';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ROOT ADMIN ONLY. One-time move of Guest moments onto its own permissions:
 * admins who could use it through the invite permission keep it, on every
 * current event. POST {} previews (writes nothing); POST {apply:true} writes.
 * Safe to run repeatedly: admins the owner already configured are skipped.
 */
export async function POST(req: NextRequest) {
  const admin = await getAdminContext(req);
  if (!admin) return unauthorized();
  if (admin.accountType !== 'ROOT_ADMIN') return forbidden('Only the Root Admin can do this.');

  const body = (await req.json().catch(() => ({}))) as { apply?: boolean };
  const r = await backfillMomentsAccess(db(), { dryRun: body.apply !== true });

  // names for a readable preview
  const names: Record<string, string> = {};
  for (const id of r.updated) {
    const d = (await db().collection('users').doc(id).get()).data();
    names[id] = String(d?.displayName || d?.email || id);
  }
  return NextResponse.json({
    ok: true, applied: body.apply === true, eventCount: r.eventCount,
    updated: r.updated.map((id) => ({ uid: id, name: names[id] })), skippedCount: r.skipped.length,
  });
}
