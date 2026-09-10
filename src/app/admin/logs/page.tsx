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

  if (!eventId) return <p className="text-brand-navy-700/60">Select an event first.</p>;

  const visible = filter ? rows.filter((r) => r.result === filter) : rows;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold text-brand-navy-900">Scan logs (latest 100, live)</h2>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-1.5 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500"
        >
          <option value="">All results</option>
          <option value="accepted">Accepted</option>
          <option value="already_used">Already used</option>
          <option value="revoked">Revoked</option>
          <option value="invalid">Invalid</option>
          <option value="scanning_disabled">Scanning disabled</option>
        </select>
        <span className="text-sm text-brand-navy-700/60">
          {accepted} accepted · {rejected} rejected
        </span>
        <button onClick={exportCsv} className="ml-auto rounded-lg bg-brand-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-blue-600">
          Export CSV (full log)
        </button>
      </div>

      {activity.error && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {activity.error}{' '}
          <button onClick={activity.retry} className="rounded bg-red-600 px-2 py-0.5 text-white">Retry</button>
        </div>
      )}
      {activity.loading && (
        <div className="animate-pulse space-y-2 rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
          <div className="h-4 rounded bg-brand-ice-100" />
          <div className="h-4 rounded bg-brand-ice-100" />
          <div className="h-4 rounded bg-brand-ice-100" />
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-brand-ice-200 bg-brand-ice-50 text-left text-xs font-semibold uppercase tracking-wide text-brand-navy-700/50">
              <th className="px-4 py-2.5">Time</th>
              <th className="px-4 py-2.5">Result</th>
              <th className="px-4 py-2.5">Serial</th>
              <th className="px-4 py-2.5">Usher</th>
              <th className="px-4 py-2.5">Gate</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-brand-ice-100 transition hover:bg-brand-ice-50/60">
                <td className="px-4 py-2.5 text-brand-navy-700/60">{fmt(r.scannedAt)}</td>
                <td className={`px-4 py-2.5 font-medium ${RESULT_STYLE[r.result] ?? 'text-brand-navy-900'}`}>{r.result}</td>
                <td className="px-4 py-2.5 font-mono text-brand-navy-900">{r.serialNumber ?? '—'}</td>
                <td className="px-4 py-2.5 text-brand-navy-800">{r.usherName ?? '—'}</td>
                <td className="px-4 py-2.5 text-brand-navy-700/60">{r.gateId ?? '—'}</td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-brand-navy-700/50">No scan logs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
