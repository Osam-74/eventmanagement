import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { createUsherSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { createUsher } from '@/lib/services/usherAuth';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canManageUshers');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';
  const snap = await db().collection('ushers').where('eventId', '==', eventId).limit(200).get();
  const ushers = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      // Ushers created before PIN-only auth (or reset while disabled) have
      // no PIN index yet — they cannot sign in until an admin resets the PIN.
      needsPinMigration: !data.pinIndex,
      lastSeenAt: data.lastSeenAt?.toDate?.()?.toISOString?.() ?? null,
      lastScanAt: data.lastScanAt?.toDate?.()?.toISOString?.() ?? null,
      lockedUntil: data.lockedUntil?.toDate?.()?.toISOString?.() ?? null,
    };
  });
  return NextResponse.json({ ok: true, ushers });
}

export async function POST(req: NextRequest) {
  const res = await requirePermission(req, 'canManageUshers');
  if ('error' in res) return res.error;

  const parsed = createUsherSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { eventId, name, pin, gateId } = parsed.data;

  const result = await createUsher(db(), {
    eventId,
    name,
    pin,
    gateId,
    createdBy: res.admin.uid,
  });

  if (!result.ok) {
    const message =
      result.code === 'PIN_TAKEN' ? result.message : result.code === 'NAME_TAKEN' ? result.message : 'Invalid input';
    return badRequest(message, 'SERVER_ERROR');
  }

  // Index bookkeeping for analytics views (never the PIN itself).
  await db().collection('ushers').doc(result.id!).update({ pinIndexSetAt: FieldValue.serverTimestamp() }).catch(() => undefined);
  await writeAudit('USHER_CREATED', res.admin.uid, { usherId: result.id, eventId, name: name.trim(), gateId });

  // The PIN is returned exactly once, only at creation time.
  return NextResponse.json({ ok: true, id: result.id, pin: result.pin });
}
