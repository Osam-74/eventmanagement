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
  tag?: string | null;
  firstUsedAt?: string | null;
  usedByUsherName?: string | null;
  checkedInAt?: string | null;
  // Multi-use cards (owner request, 2026-09-10): usageLimit is null for an
  // unlimited-use card, otherwise the number of scans it allows in total.
  usageCount?: number;
  usageLimit?: number | null;
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

    if (event.lifecycleStatus === 'closed' || event.lifecycleStatus === 'archived' || event.deleted === true) {
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
    const tag = (invitation.tag as string | null) ?? null;
    const logWithSerial = { ...baseLog, invitationSerialNumber: serialNumber };

    if (invitation.eventId !== eventId) {
      tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'wrong_event' });
      return { code: 'WRONG_EVENT', message: 'Invitation belongs to a different event' } as ScanOutcome;
    }

    if (invitation.status === 'revoked') {
      tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'revoked' });
      return { code: 'REVOKED', message: 'Invitation revoked', serialNumber, tag } as ScanOutcome;
    }

    // Flexible generation (owner request, 2026-09-10): usageLimit === null
    // means unlimited uses; a normal card is usageLimit === 1 (the same
    // single-use behavior as before this feature). Invitations generated
    // before this feature shipped carry no usageLimit field at all —
    // treat that exactly as limit 1, reproducing today's behavior for
    // every card generated to date, byte for byte.
    const usageLimitRaw = invitation.usageLimit as number | null | undefined;
    const usageLimit = usageLimitRaw === undefined ? 1 : usageLimitRaw;
    const usageCount = (invitation.usageCount as number | undefined) ?? 0;
    const exhausted = invitation.status === 'used' || (usageLimit !== null && usageCount >= usageLimit);

    if (exhausted) {
      tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'already_used' });
      const firstUsedAt = (invitation.firstUsedAt as Timestamp | null)?.toDate?.() ?? (invitation.usedAt as Timestamp | null)?.toDate?.();
      return {
        code: 'ALREADY_USED',
        message: usageLimit !== null && usageLimit > 1 ? 'This card has no uses left' : 'Invitation already used',
        serialNumber,
        tag,
        firstUsedAt: firstUsedAt ? firstUsedAt.toISOString() : null,
        usedByUsherName: (invitation.usedByUsherName as string | null) ?? null,
        usageCount,
        usageLimit,
      } as ScanOutcome;
    }

    // ---- valid invitation with allowance remaining: consume atomically ----
    const checkedInAt = Timestamp.now();
    const newUsageCount = usageCount + 1;
    const willExhaust = usageLimit !== null && newUsageCount >= usageLimit;
    tx.update(invitationRef, {
      status: willExhaust ? 'used' : 'unused',
      usageCount: newUsageCount,
      // firstUsedAt is set once and never overwritten — the historical
      // record of the very first admission, kept even across many reuses.
      firstUsedAt: invitation.firstUsedAt ?? FieldValue.serverTimestamp(),
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
    tx.update(eventRef, {
      // totalCheckIns: every accepted admission, including repeat scans of
      // one multi-use card — "how many people we let in in total".
      totalCheckIns: FieldValue.increment(1),
      // totalUsed: increments by exactly 1 the moment a CARD becomes
      // exhausted (not per scan) — for single-use cards that is still
      // its one and only scan, so this is byte-identical to the counter's
      // pre-existing meaning. Keeps the dashboard's "unused = generated -
      // used - revoked" arithmetic correct even with multi-use cards.
      ...(willExhaust ? { totalUsed: FieldValue.increment(1) } : {}),
    });
    tx.create(firestore.collection('scanLogs').doc(), { ...logWithSerial, result: 'accepted' });

    return {
      code: 'ACCEPTED',
      message: 'Access granted',
      serialNumber,
      tag,
      checkedInAt: checkedInAt.toDate().toISOString(),
      usageCount: newUsageCount,
      usageLimit,
    } as ScanOutcome;
  });
}
