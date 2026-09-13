import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';
import { resolveSerialGeometry, resolveQrBoxGeometry, resolveAccessLabelGeometry, resolveQrGeometry } from '@/lib/invitation/geometry';
import { renderInvitationImage } from '@/lib/invitation/render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Template preview (owner request, 2026-09-13): lets an admin see exactly
 * what a card generated from this template will look like — QR box,
 * "ACCESS CODE" label, and serial in their real positions — BEFORE picking
 * it for an event. Renders with a sample token/serial only; nothing here
 * touches Firestore invitations, batches, or counts.
 *
 * Reuses the exact same resolveQrGeometry/resolveSerialGeometry/
 * resolveAccessLabelGeometry/resolveQrBoxGeometry pipeline as the real
 * generate route (never the stale `template.qr` stored at upload time) —
 * see the 2026-09-11 bug fix in geometry.ts. That guarantees the preview
 * can never drift from what an actual generated card looks like.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const snap = await db().collection('templates').doc(id).get();
  if (!snap.exists) return NextResponse.json({ ok: false, message: 'Template not found' }, { status: 404 });
  const template = snap.data()!;

  let templateBuffer: Buffer;
  try {
    [templateBuffer] = await bucket().file(template.storagePath as string).download();
  } catch {
    return NextResponse.json({ ok: false, message: 'Could not load template artwork.' }, { status: 500 });
  }

  const canvasWidth = template.canvasWidth as number;
  const canvasHeight = template.canvasHeight as number;
  const qrGeometry = resolveQrGeometry(canvasWidth, canvasHeight, template.qrOverride as never);
  const serialGeometry = resolveSerialGeometry({ canvasWidth, canvasHeight, qr: qrGeometry, serial: template.serial as never });
  const accessLabelGeometry = resolveAccessLabelGeometry({ canvasWidth, canvasHeight, qr: qrGeometry });

  const { buffer, contentType } = await renderInvitationImage({
    templateBuffer,
    geometry: {
      canvasWidth,
      canvasHeight,
      qr: qrGeometry,
      accessLabel: accessLabelGeometry,
      serial: serialGeometry,
      qrBox: resolveQrBoxGeometry(template.qrBox as never),
    },
    qrToken: 'PREVIEW-SAMPLE-NOT-A-REAL-CARD',
    serial: 'PREVIEW',
    profile: 'share',
  });

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': contentType,
      // Admin-only, sample content — short private cache is fine, never CDN-shared.
      'Cache-Control': 'private, max-age=120',
    },
  });
}
