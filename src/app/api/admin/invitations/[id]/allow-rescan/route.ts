import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { allowRescanSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Allow-rescan flow (e.g. network issue on event day):
 * A scan succeeded server-side but the scanner response was lost, so the
 * usher could not show ACCESS GRANTED and the guest is stuck at the gate.
 * An admin searches the card's serial number, sees who scanned it and when,
 * and can explicitly release it back to `unused` so the gate can scan it
 * again. Every release is recorded on the invitation and in the audit log.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // id = tokenDigest (document id)
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = allowRescanSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('A reason of at least 3 characters is required.');
  const { reason } = parsed.data;

  const invitationRef = db().collection('invitations').doc(id);
  let serial: string | null = null;
  let previous: Record<string, unknown> = {};

  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(invitationRef);
      if (!snap.exists) throw new Error('NOT_FOUND');
      const data = snap.data()!;
      serial = data.serialNumber as string;
      if (data.status !== 'used') throw new Error('NOT_USED');

      previous = {
        usedAt: data.usedAt,
        usedByUsherId: data.usedByUsherId,
        usedByUsherName: data.usedByUsherName,
        gateId: data.gateId,
      };

      tx.update(invitationRef, {
        status: 'unused',
        usedAt: null,
        usedAtClientEstimate: null,
        usedByUsherId: null,
        usedByUsherName: null,
        gateId: null,
        rescanHistory: FieldValue.arrayUnion({
          at: FieldValue.serverTimestamp(),
          allowedBy: res.admin.uid,
          allowedByName: res.admin.displayName || res.admin.email,
          reason,
          previous: {
            usedAt: data.usedAt ?? null,
            usedByUsherId: data.usedByUsherId ?? null,
            usedByUsherName: data.usedByUsherName ?? null,
            gateId: data.gateId ?? null,
          },
        }),
        rescanAllowedAt: FieldValue.serverTimestamp(),
        rescanAllowedBy: res.admin.uid,
      });

      tx.update(db().collection('events').doc(data.eventId as string), {
        totalUsed: FieldValue.increment(-1),
        rescanAllowedCount: FieldValue.increment(1),
      });

      if (data.usedByUsherId) {
        tx.update(db().collection('ushers').doc(data.usedByUsherId as string), {
          acceptedCount: FieldValue.increment(-1),
        });
      }
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'NOT_FOUND') return badRequest('Invitation not found');
    if (msg === 'NOT_USED') return badRequest('Only already-scanned (used) invitations can be released for rescan.');
    return badRequest('Could not release invitation for rescan.');
  }

  await writeAudit('RESCAN_ALLOWED', res.admin.uid, { invitationId: id, serialNumber: serial, reason });
  return NextResponse.json({ ok: true, serialNumber: serial });
}
