import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import type { AdminActor } from './invitationAdmin';

/**
 * Table / seat assignment for a card (owner request, 2026-10-02).
 *
 * The table lives ONLY in the database (`invitations.tableNumber`). It is
 * shown to the usher when the card is scanned and nowhere else: it is never
 * drawn on the card image, and nothing here reads or writes the QR, the
 * image, the tag, the serial, the scan counters or the status. Setting a
 * table therefore cannot change how a card already sent out looks or scans.
 *
 * Absent / null / blank = no table assigned: scanning shows nothing extra,
 * exactly as before this feature.
 */
export const TABLE_MAX_LENGTH = 24;
export const BULK_TABLE_MAX = 500;

export type TableParse = { ok: true; value: string | null } | { ok: false; message: string };

/** Normalise what an admin typed: trim, collapse inner spaces; blank clears the table. */
export function parseTableNumber(input: unknown): TableParse {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, message: 'Table must be text or a number.' };
  const v = input.replace(/\s+/g, ' ').trim();
  if (v === '') return { ok: true, value: null };
  if (v.length > TABLE_MAX_LENGTH) return { ok: false, message: `Table must be ${TABLE_MAX_LENGTH} characters or fewer.` };
  // Letters/numbers (any language) plus a few harmless separators: "12", "A3", "Table 4", "VIP-2", "Head Table".
  if (!/^[\p{L}\p{N} .,#\-\/&']+$/u.test(v)) {
    return { ok: false, message: "Table can only contain letters, numbers, spaces and these symbols: . , # - / & '" };
  }
  return { ok: true, value: v };
}

/** The table to show an usher for a stored invitation (null when none is set). */
export function tableForDisplay(stored: unknown): string | null {
  if (typeof stored !== 'string') return null;
  const v = stored.trim();
  return v === '' ? null : v;
}

type Result =
  | { ok: true; changed: number; unchanged: number; skipped: { id: string; reason: string }[] }
  | { ok: false; code: 'INVALID' | 'ERROR'; message: string };

/**
 * Set (or clear) the table on one or many cards of ONE event.
 * - Only `tableNumber` is written (plus an audit entry). Nothing else on the card changes.
 * - Each card is updated in its own transaction, so a scan landing at the same moment is never overwritten.
 * - A card that no longer exists, or belongs to another event, is skipped and reported, never touched.
 * - Revoked cards may still be given a table (harmless; it is never shown for a revoked card).
 */
export async function setInvitationTables(
  firestore: Firestore,
  input: { eventId: string; invitationIds: string[]; table: string | null; admin: AdminActor }
): Promise<Result> {
  const ids = [...new Set(input.invitationIds)];
  if (ids.length === 0) return { ok: false, code: 'INVALID', message: 'Select at least one card.' };
  if (ids.length > BULK_TABLE_MAX) return { ok: false, code: 'INVALID', message: `You can update up to ${BULK_TABLE_MAX} cards at a time.` };
  const parsed = parseTableNumber(input.table);
  if (!parsed.ok) return { ok: false, code: 'INVALID', message: parsed.message };
  const next = parsed.value;

  let changed = 0;
  let unchanged = 0;
  const skipped: { id: string; reason: string }[] = [];
  const audited: { id: string; serial: string | null; from: string | null }[] = [];

  try {
    for (const id of ids) {
      const ref = firestore.collection('invitations').doc(id);
      const outcome = await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { kind: 'skip' as const, reason: 'not found' };
        const data = snap.data()!;
        if (data.eventId !== input.eventId) return { kind: 'skip' as const, reason: 'belongs to a different event' };
        const prev = tableForDisplay(data.tableNumber);
        if (prev === next) return { kind: 'same' as const };
        tx.update(ref, { tableNumber: next }); // the ONLY field written
        return { kind: 'set' as const, serial: (data.serialNumber as string) ?? null, from: prev };
      });
      if (outcome.kind === 'skip') skipped.push({ id, reason: outcome.reason });
      else if (outcome.kind === 'same') unchanged += 1;
      else { changed += 1; audited.push({ id, serial: outcome.serial, from: outcome.from }); }
    }
  } catch (e) {
    console.error('set table error', (e as Error).message);
    return { ok: false, code: 'ERROR', message: 'Could not save the table. Nothing further was changed.' };
  }

  if (changed > 0) {
    await firestore.collection('auditLogs').add({
      action: 'INVITATION_TABLE_CHANGED',
      actor: input.admin.uid,
      actorType: 'admin',
      detail: {
        eventId: input.eventId,
        to: next,
        count: changed,
        // keep the record small: full detail for small edits, a sample for big ones
        cards: audited.slice(0, 50),
      },
      at: FieldValue.serverTimestamp(),
    });
  }
  return { ok: true, changed, unchanged, skipped };
}
