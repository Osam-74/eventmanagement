import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export type ToggleResult =
  | { ok: true; scanningEnabled: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'ERROR'; message: string };

/**
 * Scanning activation. The enabled flag is authoritative server state that
 * every scan re-reads inside its own transaction — deactivating takes
 * effect on the very next scan attempt from any already-open scanner.
 * Closing/archiving an event also forces scanning off.
 */
export async function toggleScanning(
  firestore: Firestore,
  input: { eventId: string; enabled: boolean; actorUid: string }
): Promise<ToggleResult> {
  const { eventId, enabled, actorUid } = input;
  const ref = firestore.collection('events').doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Event not found' };
  const event = snap.data()!;

  const lifecycleStatus = event.lifecycleStatus as string;
  const effective = enabled && lifecycleStatus !== 'closed' && lifecycleStatus !== 'archived';

  await ref.update({
    scanningEnabled: effective,
    scanningEnabledAt: FieldValue.serverTimestamp(),
    scanningEnabledBy: actorUid,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await firestore.collection('auditLogs').add({
    action: 'SCANNING_TOGGLED',
    actor: actorUid,
    actorType: 'admin',
    detail: { eventId, enabled: effective, requestedEnabled: enabled },
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true, scanningEnabled: effective };
}
