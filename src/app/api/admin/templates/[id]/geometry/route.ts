import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { templateGeometryOverrideSchema } from '@/lib/validation/schemas';
import { resolveQrGeometry } from '@/lib/invitation/geometry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manual QR positioning (owner request, 2026-09-13) — backs the Modify
 * editor. GET returns the QR's current resolved position (override if one
 * is set, else the same default ratio-based position every other render
 * call site uses) plus the canvas size the editor needs to scale its
 * preview image. PATCH saves a new override, or clears it back to default.
 *
 * The QR is the single anchor point: the "ACCESS CODE" label and the
 * serial are already computed as an offset BELOW whatever qr.x/qr.y is
 * (see accessLabelGeometryBelowQr / serialGeometryBelowQr in geometry.ts),
 * so moving the QR moves the whole group together automatically — no
 * separate override needed for the label or serial.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const snap = await db().collection('templates').doc(id).get();
  if (!snap.exists) return NextResponse.json({ ok: false, message: 'Template not found' }, { status: 404 });
  const template = snap.data()!;
  const canvasWidth = template.canvasWidth as number;
  const canvasHeight = template.canvasHeight as number;
  const qr = resolveQrGeometry(canvasWidth, canvasHeight, template.qrOverride as never);

  return NextResponse.json({
    ok: true,
    canvasWidth,
    canvasHeight,
    qr,
    hasOverride: template.qrOverride != null,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const parsed = templateGeometryOverrideSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');

  const ref = db().collection('templates').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return NextResponse.json({ ok: false, message: 'Template not found' }, { status: 404 });
  const template = snap.data()!;
  const canvasWidth = template.canvasWidth as number;
  const canvasHeight = template.canvasHeight as number;

  if (parsed.data.x === null) {
    await ref.update({ qrOverride: null });
    await writeAudit('TEMPLATE_QR_POSITION_UPDATED', res.admin.uid, { templateId: id, reset: true });
    const qr = resolveQrGeometry(canvasWidth, canvasHeight, null);
    return NextResponse.json({ ok: true, qr, hasOverride: false });
  }

  // Clamp into the valid range rather than rejecting — the editor already
  // clamps client-side while dragging, but the canvas size is authoritative
  // server-side, so this is the actual safety net.
  const size = resolveQrGeometry(canvasWidth, canvasHeight).size;
  const x = Math.min(Math.max(parsed.data.x, 0), Math.max(0, canvasWidth - size));
  const y = Math.min(Math.max(parsed.data.y as number, 0), Math.max(0, canvasHeight - size));

  await ref.update({ qrOverride: { x, y } });
  await writeAudit('TEMPLATE_QR_POSITION_UPDATED', res.admin.uid, { templateId: id, x, y });

  const qr = resolveQrGeometry(canvasWidth, canvasHeight, { x, y });
  return NextResponse.json({ ok: true, qr, hasOverride: true });
}
