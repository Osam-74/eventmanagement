import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { digestToken } from '@/lib/qr/digest';
import { scanSchema } from '@/lib/validation/schemas';
import { verifyUsherSessionToken } from '@/lib/auth/usherSession';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Outcome = {
  code: 'ACCEPTED' | 'ALREADY_USED' | 'REVOKED' | 'INVALID' | 'WRONG_EVENT' | 'SCANNING_DISABLED' | 'EVENT_CLOSED' | 'UNAUTHORIZED';
  message: string;
  serialNumber?: string | null;
  firstUsedAt?: string | null;
  checkedInAt?: string | null;
  usedByUsherName?: string | null;
};

export async function POST(req: NextRequest) {
  const parsed = scanSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'INVALID', message: 'Malformed scan request' }, { status: 200 });
  }
  const { token, clientRequestId, gateId, deviceInfo } = parsed.data;

  const session = verifyUsherSessionToken(req.cookies.get('usher_session')?.value);
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Session expired. Sign in again.' }, { status: 401 });
  }

  const digest = digestToken(token);

  try {
    const outcome = await db().runTransaction(async (tx) => {
      // ---- reads ----
      const usherRef = db().collection('ushers').doc(session.usherId);
      const usherSnap = await tx.get(usherRef);
      if (!usherSnap.exists || usherSnap.data()?.active !== true) {
        return { code: 'UNAUTHORIZED', message: 'Usher access disabled. See an administrator.' } as Outcome;
      }
      const usherName = usherSnap.data()!.name as string;
      const eventRef = db().collection('events').doc(session.eventId);
      const eventSnap = await tx.get(eventRef);
      if (!eventSnap.exists) {
        return { code: 'UNAUTHORIZED', message: 'Event no longer exists.' } as Outcome;
      }
      const event = eventSnap.data()!;
      const invitationRef = db().collection('invitations').doc(digest);
      const invitationSnap = await tx.get(invitationRef);

      const baseLog = {
        eventId: session.eventId,
        tokenDigest: digest,
        invitationSerialNumber: null as string | null,
        result: 'invalid' as string,
        usherId: session.usherId,
        usherNameSnapshot: usherName,
        gateId: gateId ?? usherSnap.data()!.gateId ?? null,
        scannedAt: FieldValue.serverTimestamp(),
        clientRequestId,
        deviceInfo: deviceInfo ?? null,
      };

      if (event.lifecycleStatus === 'closed' || event.lifecycleStatus === 'archived') {
        tx.create(db().collection('scanLogs').doc(), { ...baseLog, result: 'event_closed' });
        return { code: 'EVENT_CLOSED', message: 'EVENT NOT OPEN' } as Outcome;
      }

      if (event.scanningEnabled !== true) {
        tx.create(db().collection('scanLogs').doc(), { ...baseLog, result: 'scanning_disabled' });
        return { code: 'SCANNING_DISABLED', message: 'EVENT NOT OPEN' } as Outcome;
      }

      if (!invitationSnap.exists) {
        tx.create(db().collection('scanLogs').doc(), baseLog);
        return { code: 'INVALID', message: 'Invitation not recognized' } as Outcome;
      }

      const invitation = invitationSnap.data()!;
      const serialNumber = invitation.serialNumber as string;
      const logWithSerial = { ...baseLog, invitationSerialNumber: serialNumber };

      if (invitation.eventId !== session.eventId) {
        tx.create(db().collection('scanLogs').doc(), { ...logWithSerial, result: 'wrong_event' });
        return { code: 'WRONG_EVENT', message: 'Invitation belongs to a different event' } as Outcome;
      }

      if (invitation.status === 'revoked') {
        tx.create(db().collection('scanLogs').doc(), { ...logWithSerial, result: 'revoked' });
        return { code: 'REVOKED', message: 'Invitation revoked', serialNumber } as Outcome;
      }

      if (invitation.status === 'used') {
        tx.create(db().collection('scanLogs').doc(), { ...logWithSerial, result: 'already_used' });
        const usedAt = (invitation.usedAt as Timestamp | null)?.toDate?.();
        return {
          code: 'ALREADY_USED',
          message: 'Invitation already used',
          serialNumber,
          firstUsedAt: usedAt ? usedAt.toISOString() : null,
          usedByUsherName: (invitation.usedByUsherName as string | null) ?? null,
        } as Outcome;
      }

      // ---- valid unused invitation: consume atomically ----
      const checkedInAt = Timestamp.now();
      tx.update(invitationRef, {
        status: 'used',
        usedAt: FieldValue.serverTimestamp(),
        usedAtClientEstimate: checkedInAt,
        usedByUsherId: session.usherId,
        usedByUsherName: usherName,
        gateId: gateId ?? usherSnap.data()!.gateId ?? null,
        clientRequestId,
      });
      tx.update(usherRef, {
        acceptedCount: FieldValue.increment(1),
        lastScanAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
      });
      tx.update(eventRef, { totalUsed: FieldValue.increment(1) });
      tx.create(db().collection('scanLogs').doc(), { ...logWithSerial, result: 'accepted' });

      return {
        code: 'ACCEPTED',
        message: 'Access granted',
        serialNumber,
        checkedInAt: checkedInAt.toDate().toISOString(),
      } as Outcome;
    });

    const body: Record<string, unknown> = { ok: outcome.code === 'ACCEPTED', ...outcome };
    return NextResponse.json(body, { status: outcome.code === 'UNAUTHORIZED' ? 401 : 200 });
  } catch (e) {
    console.error('scan error', (e as Error).message);
    return NextResponse.json({ ok: false, code: 'SERVER_ERROR', message: 'Could not validate invitation. Try again.' }, { status: 200 });
  }
}
