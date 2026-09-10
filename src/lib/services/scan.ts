import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { digestToken } from '@/lib/qr/digest';
import { normalizeSerial, hyphenateSerialCandidates } from '@/lib/invitation/serial';
import { isPlausibleToken } from '@/lib/qr/token';

export type ScanOutcomeCode =
  | 'ACCEPTED'
  | 'ALREADY_USED'
  | 'REVOKED'
  | 'INVALID'
  | 'WRONG_EVENT'
  | 'SCANNING_DISABLED'
  | 'EVENT_CLOSED'
  | 'UNAUTHORIZED';

export type ScanOutcome = {
  code: ScanOutcomeCode;
  message: string;
  serialNumber?: string | null;
  firstUsedAt?: string | null;
  usedByUsherName?: string | null;
  checkedInAt?: string | null;
};

export type ScanInput = {
  usherId: string;
  eventId: string;
  token: string;
  clientRequestId: string;
  gateId?: string | null;
  deviceInfo?: string | null;
};

/**
 * Authoritative scan validation. Everything — usher status, event scanning
 * state, invitation state — is read inside a single Firestore transaction,
 * so a stale browser cannot bypass activation and two concurrent scans of
 * one invitation cannot both succeed.
 */
/**
 * Retries the scan transaction when Firestore aborts it due to contention
 * (e.g. 50 gate phones scanning simultaneously all touch the shared event
 * counter). Firestore aborts contended transactions; the documented pattern
 * is to retry with backoff. Scans stay atomic — the retry re-reads the
 * invitation, so a card that was consumed in an earlier attempt simply
 * returns ALREADY_USED on the retry, never a double admission.
 */
const MAX_SCAN_ATTEMPTS = 6;

function isContentionAbort(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('ABORTED') || msg.includes('Transaction lock timeout') || msg.includes('too much contention');
}

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function performScan(firestore: Firestore, input: ScanInput): Promise<ScanOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await performScanOnce(firestore, input);
    } catch (e) {
      if (attempt < MAX_SCAN_ATTEMPTS && isContentionAbort(e)) {
        // exponential backoff with jitter — Firestore's documented retry pattern
        await delay(Math.min(100 * 2 ** (attempt - 1), 3000) + Math.random() * 150);
        continue;
      }
      throw e;
    }
  }
}

async function performScanOnce(firestore: Firestore, input: ScanInput): Promise<ScanOutcome> {
  const { usherId, eventId, token, clientRequestId, gateId, deviceInfo } = input;
  const digest = digestToken(token);

  // Manual entry: ushers type the card's printed serial, which is NOT the
  // QR credential the invitation doc is keyed by. Resolve a typed serial
  // to its invitation doc BEFORE the transaction (both stored shapes:
  // hyphenless new format + hyphenated legacy). The doc itself is still
  // read and locked inside the transaction, so atomic one-time check-in
  // is unchanged.
  let invitationDocId: string = digest;
  if (!isPlausibleToken(token)) {
    const normalized = normalizeSerial(token);
    if (normalized.length >= 4) {
      const forms = [normalized, ...hyphenateSerialCandidates(normalized)];
      const snap = await firestore
        .collection('invitations')
        .where('serialNumber', 'in', forms)
        .limit(1)
        .get();
      if (!snap.empty) invitationDocId = snap.docs[0].id;
    }
  }

  return firestore.runTransaction(async (tx) => {
    // ---- reads (all before writes) ----
    const usherRef = firestore.collection('ushers').doc(usherId);
    const usherSnap = await tx.get(usherRef);
    if (!usherSnap.exists || usherSnap.data()?.active !== true) {
      return { code: 'UNAUTHORIZED', message: 'Usher access disabled. See an administrator.' } as ScanOutcome;
    }
    const usherName = usherSnap.data()!.name as string;
    const effectiveGate = gateId ?? (usherSnap.data()!.gateId as string | null) ?? null;

    const eventRef = firestore.collection('events').doc(eventId);
    const eventSnap = await tx.get(eventRef);
    if (!eventSnap.exists) {
      return { code: 'UNAUTHORIZED', message: 'Event no longer exists.' } as ScanOutcome;
    }
    const event = eventSnap.data()!;

    const invitationRef = firestore.collection('invitations').doc(invitationDocId);
    const invitationSnap = await tx.get(invitationRef);

    const baseLog = {
      eventId,
      tokenDigest: invitationSnap.exists ? invitationSnap.id : digest,
      invitationSerialNumber: null as string | null,
      result: 'invalid' as string,
      usherId,
      usherNameSnapshot: usherName,
      gateId: effectiveGate,
      scannedAt: FieldValue.serverTimestamp(),
      clientRequestId,
      deviceInfo: deviceInfo ?? null,
    };

    if (event.lifecycleStatus === 'closed' || event.lifecycleStatus === 'archived') {
      tx.create(firestore.collection('scanLogs').doc(), { ...baseLog, result: 'event_closed' });
      return { code: 'EVENT_CLOSED', message: 'EVENT NOT OPEN' } as ScanOutcome;
    }

    if (event.scanningEnabled !== true) {
      tx.create(firestore.collection('scanLogs').doc(), { ...baseLog, result: 'scanning_disabled' });
      return { code: 'SCANNING_DISABLED', message: 'EVENT NOT OPEN' } as ScanOutcome;
    }

    if (!invitationSnap.exists) {
      tx.create(firestore.collection('scanLogs').doc(), baseLog);
      return { code: 'INVALID', message: 'Invitation not recognized' } as ScanOutcome;
    }

    const invitation = invitationSnap.data()!;
    const serialNumber = invitation.serialNumber as string;
    const logWithSerial = { ...baseLog, invitationSerialNumber: serialNumber };

    if (invitation.eventId !== eventId) {
      tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'wrong_event' });
      return { code: 'WRONG_EVENT', message: 'Invitation belongs to a different event' } as ScanOutcome;
    }

    if (invitation.status === 'revoked') {
      tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'revoked' });
      return { code: 'REVOKED', message: 'Invitation revoked', serialNumber } as ScanOutcome;
    }

    if (invitation.status === 'used') {
      tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'already_used' });
      const usedAt = (invitation.usedAt as Timestamp | null)?.toDate?.();
      return {
        code: 'ALREADY_USED',
        message: 'Invitation already used',
        serialNumber,
        firstUsedAt: usedAt ? usedAt.toISOString() : null,
        usedByUsherName: (invitation.usedByUsherName as string | null) ?? null,
      } as ScanOutcome;
    }

    // ---- valid unused invitation: consume atomically ----
    const checkedInAt = Timestamp.now();
    tx.update(invitationRef, {
      status: 'used',
      usedAt: FieldValue.serverTimestamp(),
      usedAtClientEstimate: checkedInAt,
      usedByUsherId: usherId,
      usedByUsherName: usherName,
      gateId: effectiveGate,
      clientRequestId,
    });
    tx.update(usherRef, {
      acceptedCount: FieldValue.increment(1),
      lastScanAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    });
    tx.update(eventRef, { totalUsed: FieldValue.increment(1) });
    tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'accepted' });

    return {
      code: 'ACCEPTED',
      message: 'Access granted',
      serialNumber,
      checkedInAt: checkedInAt.toDate().toISOString(),
    } as ScanOutcome;
  });
}
