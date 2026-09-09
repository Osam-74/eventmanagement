'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, adminJson } from '@/lib/client/api';
import { useSelectedEvent } from '@/lib/client/useAdmin';

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
  const [rows, setRows] = useState<ScanRow[]>([]);
  const [filter, setFilter] = useState('');
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);

  const load = useCallback(() => {
    if (!eventId) return;
    adminJson<{ ok: boolean; dashboard: { recentScans: ScanRow[]; scanCounts: { accepted: number; rejected: number } } | null }>(
      `/api/admin/dashboard?eventId=${eventId}`
    ).then((r) => {
      if (r?.dashboard) {
        setRows(r.dashboard.recentScans);
        setAccepted(r.dashboard.scanCounts.accepted);
        setRejected(r.dashboard.scanCounts.rejected);
      }
    });
  }, [eventId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

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
        <h2 className="font-semibold">Scan logs (latest 25, live)</h2>
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
