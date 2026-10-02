import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { Timestamp } from 'firebase-admin/firestore';

const iso = (v: unknown): string | null => (v instanceof Timestamp ? v.toDate().toISOString() : null);
import { digestToken } from '@/lib/qr/digest';
import { normalizeSerial, hyphenateSerialCandidates } from '@/lib/invitation/serial';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { deleteInvitationsSchema } from '@/lib/validation/schemas';
import { deleteInvitations } from '@/lib/services/invitationAdmin';
import { scanInvitations, listTags } from '@/lib/services/invitationSearch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InvitationDTO = Record<string, unknown>;

/** Digest of a pasted QR credential, or null when the text is not a valid token. */
function safeDigest(text: string): string | null {
  try { return digestToken(text); } catch { return null; }
}
/** A serial looks like LETTERS then digits (ISWED00042). Plain words like FAMILY or 42 do not. */
const isSerialShaped = (normalized: string) => /^[A-Z][A-Z0-9]*\d{3,}$/.test(normalized);

function toDTO(id: string, data: Record<string, unknown>): InvitationDTO {
  return {
    id,
    eventId: data.eventId,
    batchId: data.batchId,
    serialNumber: data.serialNumber,
    tag: data.tag ?? null,
    tableNumber: typeof data.tableNumber === 'string' && data.tableNumber.trim() ? data.tableNumber.trim() : null,
    usageLimit: data.usageLimit === undefined ? 1 : data.usageLimit,
    usageCount: data.usageCount ?? (data.status === 'used' ? 1 : 0),
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
  const tag = (url.searchParams.get('tag') ?? '').slice(0, 60);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
  const skip = Math.max(parseInt(url.searchParams.get('skip') ?? '0', 10) || 0, 0);

  if (!eventId) return badRequest('eventId is required');

  // Tags used in this event, for the Tag filter dropdown.
  if (url.searchParams.get('tags') === '1') {
    return NextResponse.json({ ok: true, tags: await listTags(db(), eventId) });
  }

  let items: InvitationDTO[] = [];
  const statusFilter = (['unused', 'used', 'revoked'] as const).find((x) => x === status) ?? '';
  const scanTagOk = (i: InvitationDTO, t: string) => {
    const v = typeof i.tag === 'string' ? i.tag.trim() : '';
    return t === '__tagged__' ? v !== '' : t === '__untagged__' ? v === '' : v.toUpperCase() === t.trim().toUpperCase();
  };
  /** Substring search over serial + tag (and the tag filter), paged in memory with exact totals. */
  const containsResponse = async (exactFirst: string[] = []) => {
    const { docs: found, truncated } = await scanInvitations(db(), { eventId, text: q, status: statusFilter, tag });
    const docs = [...found.filter((d) => exactFirst.includes(d.id)), ...found.filter((d) => !exactFirst.includes(d.id))];
    const page = docs.slice(skip, skip + limit).map((d) => toDTO(d.id, d.data));
    return NextResponse.json({ ok: true, items: page, total: docs.length, truncated });
  };

  /** When exactly one card is shown, attach its recent scans (who scanned it, and when). */
  const withHistory = async (list: InvitationDTO[]) => {
    if (list.length !== 1) return list;
    const logs = await db()
      .collection('scanLogs')
      .where('tokenDigest', '==', list[0].id)
      .orderBy('scannedAt', 'desc')
      .limit(10)
      .get();
    (list[0] as Record<string, unknown>).recentScans = logs.docs.map((d) => {
      const data = d.data();
      return {
        result: data.result,
        usherName: data.usherNameSnapshot,
        gateId: data.gateId,
        scannedAt: data.scannedAt?.toDate?.()?.toISOString?.() ?? null,
      };
    });
    return list;
  };

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

    // The exact lookups ignore the status/tag filters, so apply them to what they found.
    items = items.filter((i) => (!statusFilter || i.status === statusFilter) && (!tag || scanTagOk(i, tag)));

    // A pasted QR code / one full serial is a precise trace: show just that card (with its scan history).
    const qrHit = items.some((i) => i.id === safeDigest(q));
    const serialHit = isSerialShaped(serial) && items.some((i) => normalizeSerial(String(i.serialNumber ?? '')) === serial);
    if (qrHit || serialHit) {
      // only the exactly-matched card(s), so the single-card view can show its scan history
      const exact = items.filter((i) => i.id === safeDigest(q) || normalizeSerial(String(i.serialNumber ?? '')) === serial);
      return NextResponse.json({ ok: true, items: await withHistory(exact), total: exact.length });
    }

    // Everything else is a "contains" search over serial AND tag, so typing a tag name
    // (FAMILY, VIP, BRIDE…) or part of a number finds every matching card.
    return containsResponse(items.map((i) => String(i.id)));
  }

  if (tag) return containsResponse();

  let query = db().collection('invitations').where('eventId', '==', eventId);
  if (['unused', 'used', 'revoked'].includes(status)) {
    query = query.where('status', '==', status);
  }
  const snap = await query.orderBy('serialNumber', 'asc').limit(limit).offset(skip).get();
  items = snap.docs.map((d) => toDTO(d.id, d.data() as Record<string, unknown>));

  const countSnap = await query.count().get();
  return NextResponse.json({ ok: true, items, total: countSnap.data().count });
}

/**
 * Batch delete: removes each invitation's Firestore record AND its
 * rendered card image from Storage. The admin console's confirmation
 * prompt (not this endpoint) is where the operator is told Storage will
 * be wiped too — by the time this is called, that's already agreed to.
 */
export async function DELETE(req: NextRequest) {
  const res = await requirePermission(req, 'canManageInvites');
  if ('error' in res) return res.error;

  const parsed = deleteInvitationsSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');

  const result = await deleteInvitations(db(), bucket(), {
    invitationIds: parsed.data.invitationIds,
    reason: parsed.data.reason,
    admin: { uid: res.admin.uid, displayName: res.admin.displayName, email: res.admin.email },
  });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: 400 });
  return NextResponse.json({ ok: true, deleted: result.deleted, skipped: result.skipped });
}
