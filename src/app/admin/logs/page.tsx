'use client';

import { useState } from 'react';
import { adminFetch } from '@/lib/client/api';
import { useSelectedEvent } from '@/lib/client/useAdmin';
import { useAdminWidget } from '@/lib/client/useAdminWidget';

type ScanRow = {
  id: string;
  result: string;
  serialNumber: string | null;
  usherName: string | null;
  gateId: string | null;
  scannedAt: string | null;
};

const RESULT_STYLE: Record<string, string> = {
  accepted: 'text-emerald-600',
  already_used: 'text-red-600',
  revoked: 'text-red-600',
  invalid: 'text-red-600',
  wrong_event: 'text-red-600',
  scanning_disabled: 'text-amber-600',
  event_closed: 'text-amber-600',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function LogsPage() {
  const { eventId } = useSelectedEvent();
  const [filter, setFilter] = useState('');
  // Bounded recent window (100 rows) + counts, from the lightweight activity
  // widget endpoint. Visibility-aware 10s polling with an in-flight guard —
  // a slow response can never stack overlapping requests.
  const activity = useAdminWidget<{
    recentScans: ScanRow[];
    scanCounts: { accepted: number; rejected: number };
  }>(eventId ? `/api/admin/dashboard/activity?eventId=${eventId}&limit=100` : null, { pollMs: 10000 });
  const rows = activity.data?.recentScans ?? [];
  const accepted = activity.data?.scanCounts.accepted ?? 0;
  const rejected = activity.data?.scanCounts.rejected ?? 0;

  async function exportCsv() {
    const res = await adminFetch(`/api/admin/export?eventId=${eventId}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scan-log-${eventId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!eventId) return <p className="text-stone-500">Select an event first.</p>;

  const visible = filter ? rows.filter((r) => r.result === filter) : rows;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Scan logs (latest 100, live)</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm">
          <option value="">All results</option>
          <option value="accepted">Accepted</option>
          <option value="already_used">Already used</option>
          <option value="revoked">Revoked</option>
          <option value="invalid">Invalid</option>
          <option value="scanning_disabled">Scanning disabled</option>
        </select>
        <span className="text-sm text-stone-500">
          {accepted} accepted · {rejected} rejected
        </span>
        <button onClick={exportCsv} className="ml-auto rounded-lg bg-stone-900 px-4 py-2 text-sm text-white">
          Export CSV (full log)
        </button>
      </div>

      {activity.error && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {activity.error}{' '}
          <button onClick={activity.retry} className="rounded bg-red-600 px-2 py-0.5 text-white">Retry</button>
        </div>
      )}
      {activity.loading && <div className="animate-pulse space-y-2 rounded-xl bg-white p-4 shadow-sm"><div className="h-4 rounded bg-stone-100" /><div className="h-4 rounded bg-stone-100" /><div className="h-4 rounded bg-stone-100" /></div>}
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-stone-400">
              <th className="py-2">Time</th>
              <th className="py-2">Result</th>
              <th className="py-2">Serial</th>
              <th className="py-2">Usher</th>
              <th className="py-2">Gate</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-stone-100">
                <td className="py-2 text-stone-500">{fmt(r.scannedAt)}</td>
                <td className={`py-2 font-medium ${RESULT_STYLE[r.result] ?? ''}`}>{r.result}</td>
                <td className="py-2 font-mono">{r.serialNumber ?? '—'}</td>
                <td className="py-2">{r.usherName ?? '—'}</td>
                <td className="py-2 text-stone-500">{r.gateId ?? '—'}</td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td className="py-3 text-stone-500">No scan logs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
