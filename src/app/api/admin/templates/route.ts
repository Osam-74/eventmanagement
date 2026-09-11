import { NextRequest, NextResponse } from 'next/server';
import { bucket, db } from '@/lib/firebase/admin';
import { badRequest, requirePermission } from '@/lib/api/helpers';
import { writeAudit } from '@/lib/audit';
import { FieldValue } from 'firebase-admin/firestore';
import sharp from 'sharp';
import { deriveTemplateGeometry } from '@/lib/invitation/geometry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Guard against oversized uploads eating serverless memory.
const MAX_TEMPLATE_BYTES = 15 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;
  const snap = await db().collection('templates').orderBy('createdAt', 'desc').limit(100).get();
  const templates = snap.docs.map((d) => {
    const data = d.data();
    return { id: d.id, ...data, createdAt: data.createdAt?.toDate?.()?.toISOString?.() ?? null };
  });
  return NextResponse.json({ ok: true, templates });
}

export async function POST(req: NextRequest) {
  const res = await requirePermission(req, 'canManageEvents');
  if ('error' in res) return res.error;

  const form = await req.formData().catch(() => null);
  if (!form) return badRequest('Expected multipart form data');
  const file = form.get('file');
  if (!(file instanceof File)) return badRequest('Missing artwork file');
  const name = String(form.get('name') ?? 'Default template');

  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_TEMPLATE_BYTES) return badRequest('Artwork too large (15MB max).');
  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    return badRequest('The uploaded file is not a valid image.');
  }
  if (!meta.width || !meta.height) return badRequest('Could not read image dimensions.');

  const ref = db().collection('templates').doc();
  const storagePath = `templates/${ref.id}/master${meta.format ? '.' + meta.format : ''}`;
  await bucket().file(storagePath).save(buffer, {
    metadata: { contentType: file.type || 'image/png' },
  });

  // Derive the QR box from the approved normalized placement so the template
  // scales safely to other resolutions.
  // Every template gets the gold QR box automatically (owner decision
  // 2026-09-11) — nothing to configure at upload time.
  const geometry = deriveTemplateGeometry(meta.width, meta.height);
  const { qr, accessLabel, serial, qrBox } = geometry;

  await ref.set({
    name,
    storagePath,
    canvasWidth: meta.width,
    canvasHeight: meta.height,
    qr,
    accessLabel,
    serial,
    qrBox,
    outputProfiles: { share: { longEdge: 3000 }, hq: { longEdge: 7680 } },
    version: 1,
    active: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    createdBy: res.admin.uid,
  });
  await writeAudit('TEMPLATE_UPSERTED', res.admin.uid, { templateId: ref.id, name, storagePath });

  return NextResponse.json({ ok: true, id: ref.id });
}
