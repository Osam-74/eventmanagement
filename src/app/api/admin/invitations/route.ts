import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { Timestamp } from 'firebase-admin/firestore';

const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : null);
import { digestToken } from '@/lib/qr/digest';
import { normalizeSerial, hyphenateSerialCandidates } from '@/lib/invitation/serial';
import { badRequest, requirePermission } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InvitationDTO = Record<string, unknown>;

function toDTO(id: string, data: Record<string, unknown>): InvitationDTO {
  return {
    id,
    eventId: data.eventId,
    batchId: data.batchId,
    serialNumber: data.serialNumber,
    status: data.status,
    guestAllowance: data.guestAllowance ?? 1,
    outputProfile: data.outputProfile,
    generatedAt: iso(data.generatedAt),
    generatedBy: data.generatedBy,
    usedAt: iso(data.usedAt),
    usedByUsherId: data.usedByUsherId ?? null,
    usedByUsherName: data.usedByUsherName ?? null,
    gateId: data.gateId ?? null,
    revokedAt: iso(data.revokedAt),
    revokedBy: data.revokedBy ?? null,
    revocationReason: data.revocationReason ?? null,
    supersededByInvitationId: data.supersededByInvitationId ?? null,
    supersedesInvitationId: data.supersedesInvitationId ?? null,
    rescanAllowedAt: iso(data.rescanAllowedAt),
    rescanAllowedBy: data.rescanAllowedBy ?? null,
    rescanHistory: (data.rescanHistory as unknown[] | undefined)?.map((h) => {
      const e = h as Record<string, unknown>;
      return { ...e, at: iso(e.at) ?? e.at ?? null };
    }) ?? [],
  };
}

/**
 * Search invitations for an event.
 * `q` matches either the traceable serial number (e.g. ISWED-00042)
 * or the raw scanned QR credential text.
 */
export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const url = new URL(req.url);
  const eventId = url.searchParams.get('eventId') ?? '';
  const q = url.searchParams.get('q')?.trim() ?? '';
  const status = url.searchParams.get('status') ?? '';
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
  const skip = Math.max(parseInt(url.searchParams.get('skip') ?? '0', 10) || 0, 0);

  if (!eventId) return badRequest('eventId is required');

  let items: InvitationDTO[] = [];

  if (q) {
    const serial = normalizeSerial(q);
    // 1) exact serial lookup — cover BOTH stored shapes: new cards print
    // the hyphenless serial, cards generated before the format change
    // keep the legacy "CODE-#####" form in Firestore.
    const forms = [serial, ...hyphenateSerialCandidates(serial)];
    const bySerial = await db()
      .collection('invitations')
      .where('eventId', '==', eventId)
      .where('serialNumber', 'in', forms)
      .limit(20)
      .get();
    items = bySerial.docs.map((d) => toDTO(d.id, d.data() as Record<string, unknown>));

    // 2) raw QR credential lookup (admin may paste the scanned token text)
    try {
      const digest = digestToken(q);
      const direct = await db().collection('invitations').doc(digest).get();
      if (direct.exists && !items.some((i) => i.id === direct.id)) {
        items.push(toDTO(direct.id, direct.data() as Record<string, unknown>));
      }
    } catch {
      // digest key not configured or token malformed — ignore
    }

    // single result: attach its recent scan history (scanned by who, at what time)
    if (items.length === 1) {
      const logs = await db()
        .collection('scanLogs')
        .where('tokenDigest', '==', items[0].id)
        .orderBy('scannedAt', 'desc')
        .limit(10)
        .get();
      (items[0] as Record<string, unknown>).recentScans = logs.docs.map((d) => {
        const data = d.data();
        return {
          result: data.result,
          usherName: data.usherNameSnapshot,
          gateId: data.gateId,
          scannedAt: data.scannedAt?.toDate?.()?.toISOString?.() ?? null,
        };
      });
    }

    return NextResponse.json({ ok: true, items, total: items.length });
  }

  let query = db().collection('invitations').where('eventId', '==', eventId);
  if (['unused', 'used', 'revoked'].includes(status)) {
    query = query.where('status', '==', status);
  }
  const snap = await query.orderBy('serialNumber', 'asc').limit(limit).offset(skip).get();
  items = snap.docs.map((d) => toDTO(d.id, d.data() as Record<string, unknown>));

  const countSnap = await query.count().get();
  return NextResponse.json({ ok: true, items, total: countSnap.data().count });
}
