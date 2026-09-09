import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { updateUsherSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { resetUsherPin, setUsherActive, updateUsherFields } from '@/lib/services/usherAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageUshers');
  if ('error' in res) return res.error;

  const parsed = updateUsherSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { active, resetPin, newPin, gateId, name } = parsed.data;

  const handledActive = typeof active === 'boolean';
  const handledReset = Boolean(resetPin);

  if (handledActive) {
    const result = await setUsherActive(db(), { usherId: id, active });
    if (!result.ok) return badRequest(result.message, 'SERVER_ERROR');
    await writeAudit(active ? 'USHER_ENABLED' : 'USHER_DISABLED', res.admin.uid, { usherId: id });
  }

  if (handledReset) {
    const result = await resetUsherPin(db(), { usherId: id, newPin });
    if (!result.ok) return badRequest(result.message, 'SERVER_ERROR');
    await writeAudit('USHER_PIN_RESET', res.admin.uid, { usherId: id });
    // A PIN reset is also the migration path for legacy ushers.
    return NextResponse.json({ ok: true, pin: result.pin, migrated: true });
  }

  if (!handledActive && (gateId !== undefined || name)) {
    const result = await updateUsherFields(db(), { usherId: id, gateId, name });
    if (!result.ok) return badRequest(result.message, 'SERVER_ERROR');
    await writeAudit('USHER_UPDATED', res.admin.uid, { usherId: id, gateId, name });
  }

  return NextResponse.json({ ok: true, pin: null });
}
