import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { updateUsherSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { generateRandomPin, pinVerifier } from '@/lib/auth/pin';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageUshers');
  if ('error' in res) return res.error;

  const parsed = updateUsherSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { active, resetPin, newPin, gateId, name } = parsed.data;

  const ref = db().collection('ushers').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return badRequest('Usher not found');

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (typeof active === 'boolean') {
    update.active = active;
    if (!active) update.lockedUntil = null;
  }
  if (gateId !== undefined) update.gateId = gateId;
  if (name) {
    update.name = name.trim();
    update.normalizedName = name.trim().toLowerCase();
  }

  let returnedPin: string | null = null;
  if (resetPin) {
    const chosen = newPin ?? generateRandomPin();
    update.pinVerifier = pinVerifier(id, chosen);
    update.failedAttempts = 0;
    update.lockedUntil = null;
    returnedPin = chosen;
  }

  await ref.update(update);

  if (typeof active === 'boolean') {
    await writeAudit(active ? 'USHER_ENABLED' : 'USHER_DISABLED', res.admin.uid, { usherId: id });
  } else if (resetPin) {
    await writeAudit('USHER_PIN_RESET', res.admin.uid, { usherId: id });
  } else {
    await writeAudit('USHER_UPDATED', res.admin.uid, { usherId: id, gateId, name });
  }

  return NextResponse.json({ ok: true, pin: returnedPin });
}
