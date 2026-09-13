import { db } from '@/lib/firebase/admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export type AuditAction =
  | 'ADMIN_CREATED'
  | 'ADMIN_UPDATED'
  | 'ADMIN_DISABLED'
  | 'ADMIN_DELETED'
  | 'TEMPLATE_DELETED'
  | 'EVENT_CREATED'
  | 'EVENT_UPDATED'
  | 'EVENT_ARCHIVED'
  | 'EVENT_RESTORED'
  | 'EVENT_PERMANENTLY_DELETED'
  | 'SCANNING_TOGGLED'
  | 'TEMPLATE_UPSERTED'
  | 'TEMPLATE_QR_POSITION_UPDATED'
  | 'BATCH_CREATED'
  | 'INVITATION_REVOKED'
  | 'RESCAN_ALLOWED'
  | 'USHER_CREATED'
  | 'USHER_UPDATED'
  | 'USHER_PIN_RESET'
  | 'USHER_DISABLED'
  | 'USHER_ENABLED'
  | 'ROOT_ADMIN_BOOTSTRAPPED';

export async function writeAudit(action: AuditAction, actor: string, detail: Record<string, unknown>) {
  await db()
    .collection('auditLogs')
    .add({
      action,
      actor,
      actorType: 'admin',
      detail,
      at: FieldValue.serverTimestamp(),
    });
}

export function now(): Timestamp {
  return Timestamp.now();
}
