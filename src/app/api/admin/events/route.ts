import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { createEventSchema } from '@/lib/validation/schemas';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { eventCodeFromSlug } from '@/lib/invitation/serial';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;
  // Archived (deleted) events are dropped from every normal list/selector —
  // including the global event switcher in the admin layout, so a deleted
  // event's cards simply become unreachable through the UI. Pass
  // ?archived=true to fetch the Archive tab's contents instead. Filtered
  // in-memory (not a Firestore `where`) so pre-existing event docs with no
  // `deleted` field at all are correctly treated as "not archived".
  const wantArchived = new URL(req.url).searchParams.get('archived') === 'true';
  const snap = await db().collection('events').orderBy('createdAt', 'desc').limit(100).get();
  const events = snap.docs
    .map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        eventDate: data.eventDate?.toDate?.()?.toISOString?.() ?? null,
        scanningEnabledAt: data.scanningEnabledAt?.toDate?.()?.toISOString?.() ?? null,
        createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null,
        deletedAt: data.deletedAt?.toDate?.()?.toISOString?.() ?? null,
        deleted: data.deleted === true,
      };
    })
    .filter((e) => (wantArchived ? e.deleted : !e.deleted));
  return NextResponse.json({ ok: true, events });
}

export async function POST(req: NextRequest) {
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const parsed = createEventSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Invalid input');
  const { name, slug, code, eventDate, timezone } = parsed.data;

  const clash = await db().collection('events').where('slug', '==', slug).limit(1).get();
  if (!clash.empty) return badRequest('An event with this slug already exists');

  const ref = db().collection('events').doc();
  await ref.set({
    name,
    slug,
    code: (code ?? eventCodeFromSlug(slug)).toUpperCase(),
    eventDate: new Date(eventDate),
    timezone,
    lifecycleStatus: 'draft',
    scanningEnabled: false,
    scanningEnabledAt: null,
    scanningEnabledBy: null,
    templateId: null,
    lastSerialSequence: 0,
    totalGenerated: 0,
    totalUsed: 0,
    totalRevoked: 0,
    rescanAllowedCount: 0,
    deleted: false,
    deletedAt: null,
    deletedBy: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAudit('EVENT_CREATED', res.admin.uid, { eventId: ref.id, name, slug });

  return NextResponse.json({ ok: true, id: ref.id });
}
