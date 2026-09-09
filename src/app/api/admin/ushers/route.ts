import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { createUsherSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { generateRandomPin, pinVerifier } from '@/lib/auth/pin';
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

  const eventSnap = await db().collection('events').doc(eventId).get();
  if (!eventSnap.exists) return badRequest('Event not found');

  const normalizedName = name.trim().toLowerCase();
  const clash = await db()
    .collection('ushers')
    .where('eventId', '==', eventId)
    .where('normalizedName', '==', normalizedName)
    .limit(1)
    .get();
  if (!clash.empty) return badRequest('An usher with this name already exists for this event');

  const chosenPin = pin ?? generateRandomPin();
  const ref = db().collection('ushers').doc();
  await ref.set({
    eventId,
    name: name.trim(),
    normalizedName,
    pinVerifier: pinVerifier(ref.id, chosenPin),
    active: true,
    gateId: gateId ?? null,
    failedAttempts: 0,
    lockedUntil: null,
    acceptedCount: 0,
    lastSeenAt: null,
    lastScanAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: res.admin.uid,
  });
  await writeAudit('USHER_CREATED', res.admin.uid, { usherId: ref.id, eventId, name: name.trim(), gateId });

  // The PIN is returned exactly once, only at creation time.
  return NextResponse.json({ ok: true, id: ref.id, pin: chosenPin });
}
