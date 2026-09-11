import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { generateBatchSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { generateQrToken } from '@/lib/qr/token';
import { digestToken } from '@/lib/qr/digest';
import { formatSerial } from '@/lib/invitation/serial';
import { resolveSerialGeometry, resolveQrBoxGeometry, resolveAccessLabelGeometry, resolveQrGeometry } from '@/lib/invitation/geometry';
import { renderInvitationImage } from '@/lib/invitation/render';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const res = await requirePermission(req, 'canGenerateInvites');
  if ('error' in res) return res.error;

  const parsed = generateBatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { eventId, quantity, profile } = parsed.data;

  // Flexible generation (owner request, 2026-09-10): every card in THIS batch
  // shares the same tag + usage limit. tag prints on the card INSTEAD of the
  // serial (serial is still allocated + stored for internal traceability).
  // usageLimit omitted/null = the card can be scanned an unlimited number of
  // times; a normal single-use card is just usageLimit === 1 (the default).
  const tag = parsed.data.tag && parsed.data.tag.trim() ? parsed.data.tag.trim().toUpperCase() : null;
  const usageLimit = parsed.data.usageLimit ?? 1;

  const eventRef = db().collection('events').doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) return badRequest('Event not found');
  const event = eventSnap.data()!;
  if (event.lifecycleStatus === 'closed' || event.lifecycleStatus === 'archived' || event.deleted === true) {
    return badRequest('Event is closed/archived; generation is disabled.');
  }
  if (!event.templateId) return badRequest('Assign an invitation template to this event first.');

  const templateSnap = await db().collection('templates').doc(event.templateId as string).get();
  if (!templateSnap.exists) return badRequest('Template not found');
  const template = templateSnap.data()!;

  const [masterFile] = await bucket().file(template.storagePath as string).download();

  // Anchored to THIS template's actual qr box (not recomputed independently) —
  // guarantees the serial always lands directly under the real QR, even for
  // templates uploaded before serial support (which have no stored geometry).
  // BUG fix (2026-09-11): recompute from the current ratios, never read the
  // position frozen on the template document at upload time — see
  // resolveQrGeometry() in geometry.ts.
  const qrGeometry = resolveQrGeometry(template.canvasWidth as number, template.canvasHeight as number);
  const serialGeometry = resolveSerialGeometry({
    canvasWidth: template.canvasWidth as number,
    canvasHeight: template.canvasHeight as number,
    qr: qrGeometry,
    serial: template.serial as never,
  });

  // "ACCESS CODE" caption — same always-on, anchored-to-the-real-qr-box
  // resolution as the serial and the gold box above; no per-template
  // opt-out.
  const accessLabelGeometry = resolveAccessLabelGeometry({
    canvasWidth: template.canvasWidth as number,
    canvasHeight: template.canvasHeight as number,
    qr: qrGeometry,
  });

  // create batch record
  const batchRef = db().collection('batches').doc();
  await batchRef.set({
    eventId,
    requestedQuantity: quantity,
    completedQuantity: 0,
    failedQuantity: 0,
    status: 'generating',
    requestedBy: res.admin.uid,
    outputProfile: profile,
    tag,
    usageLimit,
    createdAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });
  await writeAudit('BATCH_CREATED', res.admin.uid, { batchId: batchRef.id, eventId, quantity, profile, tag, usageLimit });

  const items: { serialNumber: string; invitationId: string; tag: string | null }[] = [];
  let failed = 0;

  for (let i = 0; i < quantity; i++) {
    try {
      const token = generateQrToken();
      const digest = digestToken(token);

      // allocate the traceable serial number atomically per card — every
      // card gets one regardless of tag, so admins can always trace a card
      // even if a dozen "FAMILY" cards look identical on their face.
      const sequence = await db().runTransaction(async (tx) => {
        const snap = await tx.get(eventRef);
        const seq = ((snap.data()?.lastSerialSequence as number | undefined) ?? 0) + 1;
        tx.update(eventRef, { lastSerialSequence: seq, totalGenerated: FieldValue.increment(1) });
        return seq;
      });
      const serial = formatSerial(event.code as string, sequence);
      // What's actually drawn on the card face — the tag replaces the
      // serial there (same vector-glyph renderer, same styling/position).
      const cardText = tag ?? serial;

      const image = await renderInvitationImage({
        templateBuffer: masterFile,
        geometry: {
          canvasWidth: template.canvasWidth as number,
          canvasHeight: template.canvasHeight as number,
          qr: qrGeometry,
          accessLabel: accessLabelGeometry,
          serial: serialGeometry,
          qrBox: resolveQrBoxGeometry(template.qrBox as never),
        },
        qrToken: token,
        serial: cardText,
        profile,
      });

      const storagePath = `events/${eventId}/invitations/${batchRef.id}/${serial}.jpg`;
      await bucket().file(storagePath).save(image.buffer, {
        metadata: { contentType: image.contentType, metadata: { serial, eventId, batchId: batchRef.id } },
      });

      await db().collection('invitations').doc(digest).set({
        eventId,
        batchId: batchRef.id,
        serialNumber: serial,
        tag,
        usageLimit,
        usageCount: 0,
        status: 'unused',
        guestAllowance: 1,
        imageStoragePath: storagePath,
        outputProfile: profile,
        generatedAt: FieldValue.serverTimestamp(),
        generatedBy: res.admin.uid,
        firstUsedAt: null,
        usedAt: null,
        usedAtClientEstimate: null,
        usedByUsherId: null,
        usedByUsherName: null,
        gateId: null,
        revokedAt: null,
        revokedBy: null,
        revocationReason: null,
        rescanHistory: [],
        rescanAllowedAt: null,
        rescanAllowedBy: null,
      });

      items.push({ serialNumber: serial, invitationId: digest, tag });
      await batchRef.update({ completedQuantity: FieldValue.increment(1) });
    } catch (e) {
      console.error('generation item failed', (e as Error).message);
      failed += 1;
      await batchRef.update({ failedQuantity: FieldValue.increment(1) }).catch(() => undefined);
    }
  }

  const status = failed === 0 ? 'completed' : failed === quantity ? 'failed' : 'partial';
  await batchRef.update({ status, completedAt: FieldValue.serverTimestamp() });

  return NextResponse.json({
    ok: true,
    batchId: batchRef.id,
    completed: items.length,
    failed,
    items,
  });
}
