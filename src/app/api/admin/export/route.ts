import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/firebase/admin';
import { requirePermission } from '@/lib/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const res = await requirePermission(req, 'canViewAnalytics');
  if ('error' in res) return res.error;
  const eventId = new URL(req.url).searchParams.get('eventId') ?? '';

  const snap = await db()
    .collection('scanLogs')
    .where('eventId', '==', eventId)
    .orderBy('scannedAt', 'asc')
    .limit(10000)
    .get();

  const rows = [['scannedAt', 'result', 'serialNumber', 'usherName', 'gateId', 'clientRequestId', 'deviceInfo']];
  for (const doc of snap.docs) {
    const d = doc.data();
    rows.push([
      d.scannedAt?.toDate?.()?.toISOString?.() ?? '',
      d.result ?? '',
      d.invitationSerialNumber ?? '',
      d.usherNameSnapshot ?? '',
      d.gateId ?? '',
      d.clientRequestId ?? '',
      d.deviceInfo ?? '',
    ]);
  }
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="scan-log-${eventId}.csv"`,
    },
  });
}
