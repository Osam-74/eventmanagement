'use client';

import { useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';
import { useAdminWidget } from '@/lib/client/useAdminWidget';

type EventSummary = {
  id: string;
  name: string;
  eventDate: string | null;
  lifecycleStatus: string;
  scanningEnabled: boolean;
  scanningEnabledAt: string | null;
  totals: { generated: number; used: number; revoked: number; unused: number; rescansAllowed: number };
} | null;

type Activity = {
  recentScans: { id: string; result: string; serialNumber: string | null; usherName: string | null; gateId: string | null; scannedAt: string | null }[];
  scanCounts: { accepted: number; rejected: number };
  latestScanAt: string | null;
};

type Ushers = {
  ushers: { id: string; name: string; gateId: string | null; active: boolean; lockedUntil: string | null; acceptedCount: number; lastSeenAt: string | null; lastScanAt: string | null; activeNow: boolean }[];
};

type Batches = {
  batches: { id: string; status: string; requestedQuantity: number; completedQuantity: number; failedQuantity: number; outputProfile: string; createdAt: string | null }[];
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-2" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 rounded bg-brand-ice-100" />
      ))}
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
      <p>{message}</p>
      <button onClick={onRetry} className="mt-2 rounded bg-red-600 px-3 py-1 text-white">
        Retry
      </button>
    </div>
  );
}

const card = 'rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm';

export default function DashboardPage() {
  const { can } = useAdmin();
  const { eventId } = useSelectedEvent();
  const [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null);
  const [busy, setBusy] = useState(false);

  const eventWidget = useAdminWidget<{ ok: boolean; event: EventSummary }>(
    eventId ? `/api/admin/dashboard/event?eventId=${eventId}` : null,
    { pollMs: 10000 }
  );
  const activityWidget = useAdminWidget<Activity>(
    eventId ? `/api/admin/dashboard/activity?eventId=${eventId}` : null,
    { pollMs: 10000 }
  );
  const ushersWidget = useAdminWidget<Ushers>(
    eventId ? `/api/admin/dashboard/ushers?eventId=${eventId}` : null,
    { pollMs: 30000 }
  );
  const batchesWidget = useAdminWidget<Batches>(
    eventId ? `/api/admin/dashboard/batches?eventId=${eventId}` : null,
    { pollMs: 30000 }
  );

  async function toggleScanning(enabled: boolean) {
    setBusy(true);
    await adminJson(`/api/admin/events/${eventId}/scanning`, {
      method: 'POST',
      body: JSON.stringify({ enabled, confirm: true }),
    }).catch(() => undefined);
    setConfirm(null);
    setBusy(false);
    eventWidget.retry();
  }

  if (!eventId) return <p className="text-brand-navy-700/60">Create or select an event first (Events page).</p>;

  const ev = eventWidget.data?.event ?? null;

  return (
    <div className="space-y-6">
      {/* Event + scanning banner — lightweight summary, loads first */}
      <div className={`rounded-2xl p-6 text-white ${ev?.scanningEnabled ? 'bg-emerald-700' : 'bg-brand-navy-900'}`}>
        {eventWidget.loading ? (
          <Skeleton rows={2} />
        ) : eventWidget.error ? (
          <ErrorCard message={eventWidget.error} onRetry={eventWidget.retry} />
        ) : !ev ? (
          <p className="text-sm">Event not found. It may have been removed.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex-1">
                <p className="text-sm uppercase tracking-wide opacity-80">
                  Scanning — {ev.name} ({ev.lifecycleStatus})
                </p>
                <p className="text-3xl font-bold">{ev.scanningEnabled ? 'ACTIVE' : 'INACTIVE'}</p>
                <p className="text-xs opacity-75">
                  {ev.eventDate ? new Date(ev.eventDate).toLocaleDateString() : ''} · last change {fmt(ev.scanningEnabledAt)}
                </p>
              </div>
              {can('canManageEvents') && (
                <div className="space-y-2 text-right">
                  <button
                    onClick={() => ev.scanningEnabled ? setConfirm('disable') : setConfirm('enable')}
                    className={`rounded-lg px-5 py-2.5 font-semibold ${
                      ev.scanningEnabled ? 'bg-white text-red-700' : 'bg-emerald-500 text-white'
                    }`}
                  >
                    {ev.scanningEnabled ? 'Deactivate Scanning' : 'Activate Scanning'}
                  </button>
                  {confirm && (
                    <div className="rounded-lg bg-white p-3 text-left text-brand-navy-900 shadow-xl">
                      <p className="mb-2 text-sm font-medium">
                        {confirm === 'enable'
                          ? 'Activate scanning for this event now? Gate officials will be able to admit guests.'
                          : 'Deactivate scanning now? All gates will immediately stop admitting guests.'}
                      </p>
                      <div className="flex gap-2">
                        <button
                          disabled={busy}
                          onClick={() => toggleScanning(confirm === 'enable')}
                          className="rounded bg-brand-blue-500 px-3 py-1 text-sm text-white"
                        >
                          {confirm === 'enable' ? 'Yes, activate' : 'Yes, deactivate'}
                        </button>
                        <button onClick={() => setConfirm(null)} className="rounded border border-brand-ice-200 px-3 py-1 text-sm">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ['Generated', ev.totals.generated],
                ['Unused', ev.totals.unused],
                ['Admitted', ev.totals.used],
                ['Revoked', ev.totals.revoked],
                ['Rescans allowed', ev.totals.rescansAllowed],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-xl bg-black/20 p-3">
                  <p className="text-xs opacity-80">{label}</p>
                  <p className="mt-1 text-xl font-semibold">{value}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Usher roster — independent widget */}
        <div className={card}>
          <h2 className="mb-3 font-semibold">Ushers</h2>
          {ushersWidget.loading ? (
            <Skeleton rows={5} />
          ) : ushersWidget.error ? (
            <ErrorCard message={ushersWidget.error} onRetry={ushersWidget.retry} />
          ) : ushersWidget.data && ushersWidget.data.ushers.length === 0 ? (
            <p className="text-sm text-brand-navy-700/60">No ushers created yet.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {ushersWidget.data?.ushers.map((u) => (
                  <tr key={u.id} className="border-t border-brand-ice-100">
                    <td className="py-1.5">
                      <span className={`mr-2 inline-block h-2 w-2 rounded-full ${u.activeNow ? 'bg-emerald-500' : 'bg-brand-ice-200'}`} />
                      {u.name} {u.gateId && <span className="text-brand-navy-700/40">({u.gateId})</span>}
                      {!u.active && <span className="ml-1 text-red-500">disabled</span>}
                      {u.lockedUntil && <span className="ml-1 text-amber-600">locked</span>}
                    </td>
                    <td className="py-1.5 text-right text-brand-navy-700/60">
                      ✓ {u.acceptedCount} · last seen {fmt(u.lastSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent scan activity — independent widget */}
        <div className={card}>
          <h2 className="mb-3 font-semibold">Recent scans</h2>
          {activityWidget.loading ? (
            <Skeleton rows={5} />
          ) : activityWidget.error ? (
            <ErrorCard message={activityWidget.error} onRetry={activityWidget.retry} />
          ) : (
            <>
              <div className="mb-2 text-xs text-brand-navy-700/60">
                {activityWidget.data?.scanCounts.accepted ?? 0} accepted · {activityWidget.data?.scanCounts.rejected ?? 0} rejected
                {' · latest '} {fmt(activityWidget.data?.latestScanAt ?? null)}
              </div>
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {activityWidget.data?.recentScans.map((s) => (
                      <tr key={s.id} className="border-t border-brand-ice-100">
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
                        <td className="py-1.5 text-right text-brand-navy-700/60">{fmt(s.scannedAt)}</td>
                      </tr>
                    ))}
                    {activityWidget.data?.recentScans.length === 0 && (
                      <tr><td className="text-brand-navy-700/60">No scans yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Latest batches — independent widget */}
      <div className={card}>
        <h2 className="mb-3 font-semibold">Latest batches</h2>
        {batchesWidget.loading ? (
          <Skeleton rows={3} />
        ) : batchesWidget.error ? (
          <ErrorCard message={batchesWidget.error} onRetry={batchesWidget.retry} />
        ) : batchesWidget.data && batchesWidget.data.batches.length === 0 ? (
          <p className="text-sm text-brand-navy-700/60">No batches yet. Generate invitations from the Generate page.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {batchesWidget.data?.batches.map((b) => (
                <tr key={b.id} className="border-t border-brand-ice-100">
                  <td className="py-1.5">{b.completedQuantity}/{b.requestedQuantity} cards ({b.outputProfile})</td>
                  <td className="py-1.5 text-brand-navy-700/60">{b.status}</td>
                  <td className="py-1.5 text-right text-brand-navy-700/60">{fmt(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
