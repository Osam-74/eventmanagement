import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { revokeInvitationSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params; // id = tokenDigest (document id)
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = revokeInvitationSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { reason } = parsed.data;

  const invitationRef = db().collection('invitations').doc(id);
  let serial: string | null = null;

  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(invitationRef);
      if (!snap.exists) throw new Error('NOT_FOUND');
      const data = snap.data()!;
      serial = data.serialNumber as string;
      if (data.status !== 'unused') throw new Error('NOT_UNUSED');
      tx.update(invitationRef, {
        status: 'revoked',
        revokedAt: FieldValue.serverTimestamp(),
        revokedBy: res.admin.uid,
        revocationReason: reason,
      });
      tx.update(db().collection('events').doc(data.eventId as string), {
        totalRevoked: FieldValue.increment(1),
      });
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'NOT_FOUND') return badRequest('Invitation not found');
    if (msg === 'NOT_UNUSED') return badRequest('Only unused invitations can be revoked.');
    return badRequest('Could not revoke invitation.');
  }

  await writeAudit('INVITATION_REVOKED', res.admin.uid, { invitationId: id, serialNumber: serial, reason });
  return NextResponse.json({ ok: true });
}
