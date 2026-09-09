'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type Dashboard = {
  event: { id: string; name: string; eventDate: string | null; lifecycleStatus: string; scanningEnabled: boolean; scanningEnabledAt: string | null };
  totals: { generated: number; used: number; revoked: number; unused: number; rescansAllowed: number };
  scanCounts: { accepted: number; rejected: number };
  ushers: { id: string; name: string; gateId: string | null; active: boolean; lockedUntil: string | null; acceptedCount: number; lastSeenAt: string | null; lastScanAt: string | null; activeNow: boolean }[];
  recentScans: { id: string; result: string; serialNumber: string | null; usherName: string | null; gateId: string | null; scannedAt: string | null }[];
  latestScanAt: string | null;
  batches: { id: string; status: string; requestedQuantity: number; completedQuantity: number; failedQuantity: number; outputProfile: string; createdAt: string | null }[];
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function DashboardPage() {
  const { can } = useAdmin();
  const { eventId } = useSelectedEvent();
  const [data, setData] = useState<Dashboard | null>(null);
  const [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!eventId) return;
    const r = await adminJson<{ ok: boolean; dashboard: Dashboard | null }>(
      `/api/admin/dashboard?eventId=${eventId}`
    ).catch(() => null);
    if (r?.dashboard) setData(r.dashboard);
  }, [eventId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function toggleScanning(enabled: boolean) {
    setBusy(true);
    await adminJson(`/api/admin/events/${eventId}/scanning`, {
      method: 'POST',
      body: JSON.stringify({ enabled, confirm: true }),
    }).catch(() => undefined);
    setConfirm(null);
    setBusy(false);
    load();
  }

  if (!eventId) return <p className="text-stone-500">Create or select an event first (Events page).</p>;
  if (!data) return <p className="text-stone-500">Loading dashboard…</p>;

  const d = data;

  return (
    <div className="space-y-6">
      <div
        className={`rounded-2xl p-6 text-white ${d.event.scanningEnabled ? 'bg-emerald-700' : 'bg-stone-800'}`}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex-1">
            <p className="text-sm uppercase tracking-wide opacity-80">
              Scanning — {d.event.name} ({d.event.lifecycleStatus})
            </p>
            <p className="text-3xl font-bold">{d.event.scanningEnabled ? 'ACTIVE' : 'INACTIVE'}</p>
            <p className="text-xs opacity-75">
              {d.event.eventDate ? new Date(d.event.eventDate).toLocaleDateString() : ''} · last change {fmt(d.event.scanningEnabledAt)}
            </p>
          </div>
          {can('canManageEvents') && (
            <div className="space-y-2 text-right">
              <button
                onClick={() => d.event.scanningEnabled ? setConfirm('disable') : setConfirm('enable')}
                className={`rounded-lg px-5 py-2.5 font-semibold ${
                  d.event.scanningEnabled ? 'bg-white text-red-700' : 'bg-emerald-500 text-white'
                }`}
              >
                {d.event.scanningEnabled ? 'Deactivate Scanning' : 'Activate Scanning'}
              </button>
              {confirm && (
                <div className="rounded-lg bg-white p-3 text-left text-stone-800 shadow-xl">
                  <p className="mb-2 text-sm font-medium">
                    {confirm === 'enable'
                      ? 'Activate scanning for this event now? Gate officials will be able to admit guests.'
                      : 'Deactivate scanning now? All gates will immediately stop admitting guests.'}
                  </p>
                  <div className="flex gap-2">
                    <button
                      disabled={busy}
                      onClick={() => toggleScanning(confirm === 'enable')}
                      className="rounded bg-stone-900 px-3 py-1 text-sm text-white"
                    >
                      {confirm === 'enable' ? 'Yes, activate' : 'Yes, deactivate'}
                    </button>
                    <button onClick={() => setConfirm(null)} className="rounded border border-stone-300 px-3 py-1 text-sm">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ['Generated', d.totals.generated],
          ['Unused', d.totals.unused],
          ['Admitted', d.totals.used],
          ['Revoked', d.totals.revoked],
          ['Rescans allowed', d.totals.rescansAllowed],
          ['Latest scan', fmt(d.latestScanAt)],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-stone-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-semibold">Ushers</h2>
          {d.ushers.length === 0 && <p className="text-sm text-stone-500">No ushers created yet.</p>}
          <table className="w-full text-sm">
            <tbody>
              {d.ushers.map((u) => (
                <tr key={u.id} className="border-t border-stone-100">
                  <td className="py-1.5">
                    <span className={`mr-2 inline-block h-2 w-2 rounded-full ${u.activeNow ? 'bg-emerald-500' : 'bg-stone-300'}`} />
                    {u.name} {u.gateId && <span className="text-stone-400">({u.gateId})</span>}
                    {!u.active && <span className="ml-1 text-red-500">disabled</span>}
                    {u.lockedUntil && <span className="ml-1 text-amber-600">locked</span>}
                  </td>
                  <td className="py-1.5 text-right text-stone-500">
                    ✓ {u.acceptedCount} · last seen {fmt(u.lastSeenAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-semibold">Recent scans</h2>
          <div className="mb-2 text-xs text-stone-500">
            {d.scanCounts.accepted} accepted · {d.scanCounts.rejected} rejected
          </div>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>
                {d.recentScans.map((s) => (
                  <tr key={s.id} className="border-t border-stone-100">
                    <td className="py-1.5">
                      <span
                        className={`mr-2 font-medium ${
                          s.result === 'accepted' ? 'text-emerald-600' : 'text-red-600'
                        }`}
                      >
                        {s.result === 'accepted' ? '✓' : '✗'}
                      </span>
                      {s.serialNumber ?? 'unknown card'} · {s.usherName ?? ''}
                    </td>
                    <td className="py-1.5 text-right text-stone-500">{fmt(s.scannedAt)}</td>
                  </tr>
                ))}
                {d.recentScans.length === 0 && (
                  <tr><td className="text-stone-500">No scans yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-semibold">Latest batches</h2>
        {d.batches.length === 0 ? (
          <p className="text-sm text-stone-500">No batches yet. Generate invitations from the Generate page.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {d.batches.map((b) => (
                <tr key={b.id} className="border-t border-stone-100">
                  <td className="py-1.5">{b.completedQuantity}/{b.requestedQuantity} cards ({b.outputProfile})</td>
                  <td className="py-1.5 text-stone-500">{b.status}</td>
                  <td className="py-1.5 text-right text-stone-500">{fmt(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
