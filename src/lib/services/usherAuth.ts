import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { generateRandomPin, pinLookupIndex, pinVerifier } from '@/lib/auth/pin';
import { safeEqual } from '@/lib/qr/digest';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
export const PIN_LENGTH = 6;
/** Retries when auto-generating a PIN that collides with an active usher. */
const PIN_GENERATION_ATTEMPTS = 10;
/** Slows down blind guessing of unassigned PINs (registry misses). */
const MISS_DELAY_MS = 400;

/* ────────────────────────────────────────────────────────────────────────
 * PIN-only identification design (v1.3.0)
 *
 * The PIN alone identifies the usher. Lookup is done through the
 * `pinRegistry` collection whose DOCUMENT ID is pinLookupIndex(pin) —
 * a keyed HMAC of the PIN with the server-only USHER_PIN_PEPPER. Firestore
 * document-ID creation is atomic, so two active ushers can never claim the
 * same PIN index, even under concurrent admin requests (transactions
 * retry). Disabling an usher releases the index; enabling re-claims it.
 * Plaintext PINs are never stored anywhere.
 * ──────────────────────────────────────────────────────────────────────── */

export type SignInResult =
  | { ok: true; usher: { id: string; name: string }; eventId: string }
  | { ok: false; code: 'NOT_FOUND' | 'DISABLED' | 'LOCKED' | 'INVALID'; message: string; lockedMinutes?: number };

export type MutationResult =
  | { ok: true; id?: string; pin?: string }
  | { ok: false; code: 'EVENT_NOT_FOUND' | 'NAME_TAKEN' | 'PIN_TAKEN' | 'PIN_REASSIGNED' | 'NOT_FOUND'; message: string };

const registryDoc = (firestore: Firestore, idx: string) => firestore.collection('pinRegistry').doc(idx);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PIN-only sign-in. Resolves the PIN server-side to the usher account and
 * its ADMIN-ASSIGNED event — the browser never supplies a name or event.
 */
export async function usherSignIn(firestore: Firestore, input: { pin: string }): Promise<SignInResult> {
  const idx = pinLookupIndex(input.pin);
  const reg = await registryDoc(firestore, idx).get();

  if (!reg.exists) {
    // Unassigned PIN — uniform error, slightly slowed.
    await sleep(MISS_DELAY_MS);
    return { ok: false, code: 'NOT_FOUND', message: 'Invalid PIN.' };
  }

  const usherId = String(reg.data()!.usherId ?? '');
  const usherDoc = await firestore.collection('ushers').doc(usherId).get();
  const data = usherDoc.data();

  if (!usherDoc.exists || !data) {
    // Registry entry without a live usher record — treat as invalid.
    await sleep(MISS_DELAY_MS);
    return { ok: false, code: 'NOT_FOUND', message: 'Invalid PIN.' };
  }

  if (data.active !== true) {
    return { ok: false, code: 'DISABLED', message: 'This usher access is disabled. See an administrator.' };
  }

  const lockedUntil = data.lockedUntil as Timestamp | null;
  if (lockedUntil && lockedUntil.toMillis() > Date.now()) {
    const mins = Math.ceil((lockedUntil.toMillis() - Date.now()) / 60000);
    return { ok: false, code: 'LOCKED', message: `Too many failed attempts. Try again in ~${mins} minute(s).`, lockedMinutes: mins };
  }

  // Confirmation stage: timing-safe per-account verification.
  const expected = data.pinVerifier as string;
  const actual = pinVerifier(usherDoc.id, input.pin);
  if (!expected || !safeEqual(expected, actual)) {
    const failedAttempts = ((data.failedAttempts as number) ?? 0) + 1;
    const update: Record<string, unknown> = { failedAttempts, updatedAt: FieldValue.serverTimestamp() };
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = Timestamp.fromMillis(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      update.failedAttempts = 0;
    }
    await usherDoc.ref.update(update);
    return { ok: false, code: 'INVALID', message: 'Invalid PIN.' };
  }

  // Success — clear lockout bookkeeping and mark presence.
  await usherDoc.ref.update({
    failedAttempts: 0,
    lockedUntil: null,
    lastSeenAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return {
    ok: true,
    usher: { id: usherDoc.id, name: data.name as string },
    eventId: String(data.eventId ?? ''),
  };
}

/**
 * Claims a PIN index inside a transaction. Returns the chosen plaintext PIN
 * (to be shown to the admin once) or null if no candidate was free.
 */
async function tryClaimPin(
  tx: Transaction,
  firestore: Firestore,
  opts: { usherId: string; pin?: string }
): Promise<string | null> {
  const candidates: (string | undefined)[] = opts.pin
    ? [opts.pin]
    : Array.from({ length: PIN_GENERATION_ATTEMPTS }, () => generateRandomPin());

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!/^\d{6}$/.test(candidate)) continue;
    const idx = pinLookupIndex(candidate);
    const regRef = registryDoc(firestore, idx);
    const reg = await tx.get(regRef);
    if (reg.exists) {
      // Already claimed by the SAME usher (e.g. enable-after-reset) — the
      // index is effectively owned; nothing to write.
      if (reg.data()?.usherId === opts.usherId) return candidate;
      continue; // taken by another active usher — try the next
    }
    tx.create(regRef, { usherId: opts.usherId, createdAt: FieldValue.serverTimestamp() });
    return candidate;
  }
  return null;
}

/** Creates an usher: name + admin-assigned event + unique active PIN. */
export async function createUsher(
  firestore: Firestore,
  input: { eventId: string; name: string; pin?: string; gateId?: string | null; createdBy: string }
): Promise<MutationResult> {
  const eventSnap = await firestore.collection('events').doc(input.eventId).get();
  if (!eventSnap.exists) {
    return { ok: false, code: 'EVENT_NOT_FOUND', message: 'Event not found' };
  }

  const normalizedName = input.name.trim().toLowerCase();
  const ref = firestore.collection('ushers').doc();

  return firestore.runTransaction(async (tx) => {
    const clash = await tx.get(
      firestore
        .collection('ushers')
        .where('eventId', '==', input.eventId)
        .where('normalizedName', '==', normalizedName)
        .limit(1)
    );
    if (!clash.empty) {
      return { ok: false as const, code: 'NAME_TAKEN' as const, message: 'An usher with this name already exists for this event' };
    }

    const chosen = await tryClaimPin(tx, firestore, { usherId: ref.id, pin: input.pin });
    if (!chosen) {
      return { ok: false as const, code: 'PIN_TAKEN' as const, message: 'That PIN is already used by another active usher' };
    }

    tx.set(ref, {
      eventId: input.eventId,
      name: input.name.trim(),
      normalizedName,
      pinVerifier: pinVerifier(ref.id, chosen),
      pinIndex: pinLookupIndex(chosen),
      active: true,
      gateId: input.gateId ?? null,
      failedAttempts: 0,
      lockedUntil: null,
      acceptedCount: 0,
      lastSeenAt: null,
      lastScanAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: input.createdBy,
    });
    return { ok: true as const, id: ref.id, pin: chosen };
  });
}

/**
 * PIN reset — releases the old index, atomically claims the new one.
 * Uniqueness among active ushers is re-checked by the same registry
 * mechanism used at creation.
 */
export async function resetUsherPin(
  firestore: Firestore,
  input: { usherId: string; newPin?: string }
): Promise<MutationResult> {
  const ref = firestore.collection('ushers').doc(input.usherId);

  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: 'Usher not found' };
    }
    const data = snap.data()!;

    // Reads first (Firestore transactions require all reads before all
    // writes): the old registry entry, then the new index claim.
    const oldIdx = (data.pinIndex as string | undefined) ?? null;
    let releaseOld = false;
    if (oldIdx) {
      const oldReg = await tx.get(registryDoc(firestore, oldIdx));
      // Same index re-claimed by the same usher (reset to own PIN) needs
      // no release; any other old index is released after the claim.
      releaseOld = Boolean(oldReg.exists && oldReg.data()?.usherId === input.usherId
        && input.newPin && pinLookupIndex(input.newPin) !== oldIdx);
    }

    const chosen = await tryClaimPin(tx, firestore, { usherId: input.usherId, pin: input.newPin });
    if (!chosen) {
      return { ok: false as const, code: 'PIN_TAKEN' as const, message: 'That PIN is already used by another active usher' };
    }

    // Writes after all reads.
    if (releaseOld) tx.delete(registryDoc(firestore, oldIdx!));
    tx.update(ref, {
      pinVerifier: pinVerifier(input.usherId, chosen),
      pinIndex: pinLookupIndex(chosen),
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true as const, id: input.usherId, pin: chosen };
  });
}

/**
 * Enable/disable. Disabling RELEASES the PIN index (so a new usher may be
 * given the same PIN); enabling re-claims it — if another active usher took
 * the PIN while this one was disabled, the admin must reset the PIN.
 */
export async function setUsherActive(
  firestore: Firestore,
  input: { usherId: string; active: boolean }
): Promise<MutationResult> {
  const ref = firestore.collection('ushers').doc(input.usherId);

  return firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: 'Usher not found' };
    }
    const data = snap.data()!;
    const idx = (data.pinIndex as string | undefined) ?? null;

    if (!input.active) {
      if (idx) {
        const reg = await tx.get(registryDoc(firestore, idx));
        if (reg.exists && reg.data()?.usherId === input.usherId) {
          tx.delete(registryDoc(firestore, idx));
        }
      }
      tx.update(ref, { active: false, lockedUntil: null, failedAttempts: 0, updatedAt: FieldValue.serverTimestamp() });
      return { ok: true as const, id: input.usherId };
    }

    // Enabling: re-claim the index atomically.
    if (idx) {
      const reg = await tx.get(registryDoc(firestore, idx));
      if (reg.exists && reg.data()?.usherId !== input.usherId) {
        return {
          ok: false as const,
          code: 'PIN_REASSIGNED' as const,
          message: 'This PIN was reassigned to another usher while disabled. Reset the PIN, then enable.',
        };
      }
      // reg either does not exist (released at disable) or is already owned
      // by this usher (reset-then-enable) — create only in the first case.
      if (!reg.exists) {
        tx.create(registryDoc(firestore, idx), { usherId: input.usherId, createdAt: FieldValue.serverTimestamp() });
      }
    }
    tx.update(ref, { active: true, failedAttempts: 0, lockedUntil: null, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true as const, id: input.usherId };
  });
}

/** Plain (non-PIN) field updates for an usher. */
export async function updateUsherFields(
  firestore: Firestore,
  input: { usherId: string; name?: string; gateId?: string | null }
): Promise<MutationResult> {
  const ref = firestore.collection('ushers').doc(input.usherId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Usher not found' };

  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (input.gateId !== undefined) update.gateId = input.gateId;
  if (input.name) {
    update.name = input.name.trim();
    update.normalizedName = input.name.trim().toLowerCase();
  }
  await ref.update(update);
  return { ok: true, id: input.usherId };
}

/**
 * Loads an usher for a session and returns null unless the usher is active.
 * Every protected scanner operation must re-check this server-side.
 */
export async function verifyUsherActive(
  firestore: Firestore,
  usherId: string
): Promise<{ id: string; name: string; gateId: string | null; acceptedCount: number } | null> {
  const snap = await firestore.collection('ushers').doc(usherId).get();
  if (!snap.exists || snap.data()?.active !== true) return null;
  const d = snap.data()!;
  return {
    id: snap.id,
    name: d.name as string,
    gateId: (d.gateId as string | null) ?? null,
    acceptedCount: (d.acceptedCount as number) ?? 0,
  };
}
