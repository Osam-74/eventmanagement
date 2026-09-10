import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export type DeleteTemplateResult =
  | { ok: true }
  | { ok: false; code: 'NOT_FOUND' | 'IN_USE'; message: string };

/**
 * Deletes a template. Blocked while any event still has it assigned —
 * deleting out from under an assigned event wouldn't break already-generated
 * cards (the image is already rendered and stored), but it would silently
 * break that event's NEXT generate call ("Template not found"). The error
 * names which events to reassign first.
 *
 * `deleteStorageObject` is injected so tests can exercise the Firestore
 * rules (existence + in-use guard) without a real Storage bucket.
 */
export async function deleteTemplate(
  firestore: Firestore,
  input: { templateId: string; actorUid: string; deleteStorageObject: (path: string) => Promise<void> }
): Promise<DeleteTemplateResult> {
  const { templateId, deleteStorageObject } = input;

  const ref = firestore.collection('templates').doc(templateId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'NOT_FOUND', message: 'Template not found' };
  const template = snap.data()!;

  const inUse = await firestore.collection('events').where('templateId', '==', templateId).limit(5).get();
  if (!inUse.empty) {
    const names = inUse.docs.map((d) => d.data().name as string).join(', ');
    return {
      ok: false,
      code: 'IN_USE',
      message: `This template is still assigned to: ${names}. Assign those events a different template first.`,
    };
  }

  await deleteStorageObject(template.storagePath as string).catch(() => undefined);
  await ref.delete();

  await firestore.collection('auditLogs').add({
    action: 'TEMPLATE_DELETED',
    actor: input.actorUid,
    actorType: 'admin',
    detail: { templateId, name: template.name },
    at: FieldValue.serverTimestamp(),
  });

  return { ok: true };
}
