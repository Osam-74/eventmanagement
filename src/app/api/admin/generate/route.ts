import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { generateBatchSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { generateQrToken } from '@/lib/qr/token';
import { digestToken } from '@/lib/qr/digest';
import { formatSerial } from '@/lib/invitation/serial';
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

  const eventRef = db().collection('events').doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) return badRequest('Event not found');
  const event = eventSnap.data()!;
  if (event.lifecycleStatus === 'closed' || event.lifecycleStatus === 'archived') {
    return badRequest('Event is closed/archived; generation is disabled.');
  }
  if (!event.templateId) return badRequest('Assign an invitation template to this event first.');

  const templateSnap = await db().collection('templates').doc(event.templateId as string).get();
  if (!templateSnap.exists) return badRequest('Template not found');
  const template = templateSnap.data()!;

  const [masterFile] = await bucket().file(template.storagePath as string).download();

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
    createdAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });
  await writeAudit('BATCH_CREATED', res.admin.uid, { batchId: batchRef.id, eventId, quantity, profile });

  const items: { serialNumber: string; invitationId: string }[] = [];
  let failed = 0;

  for (let i = 0; i < quantity; i++) {
    try {
      const token = generateQrToken();
      const digest = digestToken(token);

      // allocate the traceable serial number atomically per card
      const sequence = await db().runTransaction(async (tx) => {
        const snap = await tx.get(eventRef);
        const seq = ((snap.data()?.lastSerialSequence as number | undefined) ?? 0) + 1;
        tx.update(eventRef, { lastSerialSequence: seq, totalGenerated: FieldValue.increment(1) });
        return seq;
      });
      const serial = formatSerial(event.code as string, sequence);

      const image = await renderInvitationImage({
        templateBuffer: masterFile,
        geometry: {
          canvasWidth: template.canvasWidth as number,
          canvasHeight: template.canvasHeight as number,
          qr: template.qr as { x: number; y: number; size: number },
          serial: template.serial as never,
        },
        qrToken: token,
        serial,
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
        status: 'unused',
        guestAllowance: 1,
        imageStoragePath: storagePath,
        outputProfile: profile,
        generatedAt: FieldValue.serverTimestamp(),
        generatedBy: res.admin.uid,
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

      items.push({ serialNumber: serial, invitationId: digest });
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
