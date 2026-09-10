'use client';

import { useSelectedEvent, useEventSummary } from '@/lib/client/useAdmin';
import { useAdminWidget } from '@/lib/client/useAdminWidget';
import { adminJson } from '@/lib/client/api';
import { useEffect, useState } from 'react';

type EventListItem = { id: string; name: string; scanningEnabled?: boolean };

type Activity = {
  recentScans: {
    id: string; result: string; serialNumber: string | null; tag: string | null;
    usageCount: number | null; usageLimit: number | null;
    usherName: string | null; gateId: string | null; scannedAt: string | null;
  }[];
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

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

/** Small monochrome line icons — restrained on purpose: one accent color, no per-card rainbow. */
function Icon({ name }: { name: 'ticket' | 'clock' | 'check' | 'x' | 'refresh' | 'layers' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'ticket':
      return (
        <svg {...common}>
          <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" />
          <path d="M13 6v12" strokeDasharray="2 2" />
        </svg>
      );
    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12.5 2.5 2.5 5-5" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m9.5 9.5 5 5m0-5-5 5" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...common}>
          <path d="M20 11a8 8 0 0 0-14.6-4.4M4 13a8 8 0 0 0 14.6 4.4" />
          <path d="M4 4v5h5M20 20v-5h-5" />
        </svg>
      );
    case 'layers':
      return (
        <svg {...common}>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m3 13 9 5 9-5" />
        </svg>
      );
  }
}

/** Mini progress ring — used, out of total, drawn with a single accent stroke. */
function ProgressRing({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" className="shrink-0 -rotate-90">
      <circle cx="20" cy="20" r={r} fill="none" stroke="currentColor" strokeWidth="4" className="text-brand-ice-200" />
      <circle
        cx="20"
        cy="20"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        className="text-brand-blue-500"
        strokeDasharray={`${c * pct} ${c}`}
      />
    </svg>
  );
}

/**
 * Usher scan-count analytics (owner request, 2026-09-10): "the number of
 * scanned cards for the ushers in form of bar chart" — a horizontal bar
 * per usher, single accent color, sorted busiest-first. Reuses the same
 * ushers widget already polled for the roster panel, so this adds zero
 * extra network requests.
 */
function UsherBarChart({ ushers }: { ushers: Ushers['ushers'] }) {
  const sorted = [...ushers].sort((a, b) => b.acceptedCount - a.acceptedCount);
  const max = Math.max(1, ...sorted.map((u) => u.acceptedCount));
  if (sorted.length === 0) return <p className="text-sm text-brand-navy-700/60">No ushers yet.</p>;
  return (
    <div className="max-h-72 space-y-2.5 overflow-auto pr-1">
      {sorted.map((u) => (
        <div key={u.id} className="flex items-center gap-3">
          <span className="w-28 shrink-0 truncate text-xs text-brand-navy-700/70" title={u.name}>{u.name}</span>
          <div className="h-2.5 flex-1 rounded-full bg-brand-ice-100">
            <div
              className="h-2.5 rounded-full bg-brand-blue-500 transition-[width]"
              style={{ width: `${(u.acceptedCount / max) * 100}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-xs font-semibold text-brand-navy-900">{u.acceptedCount}</span>
        </div>
      ))}
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon,
  ring,
}: {
  label: string;
  value: number;
  icon: 'ticket' | 'clock' | 'check' | 'x' | 'refresh' | 'layers';
  ring?: { value: number; total: number };
}) {
  return (
    <div className="group rounded-xl border border-brand-ice-200 bg-brand-ice-50 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-blue-400/40 hover:bg-brand-ice-100 hover:shadow-md">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-brand-navy-700/50">{label}</p>
        {ring ? <ProgressRing value={ring.value} total={ring.total} /> : <span className="text-brand-navy-700/35 transition group-hover:text-brand-blue-500"><Icon name={icon} /></span>}
      </div>
      <p className="mt-2 text-2xl font-semibold text-brand-navy-900">{value}</p>
      {ring && <p className="text-xs text-brand-navy-700/45">of {ring.total} generated</p>}
    </div>
  );
}

const SCAN_BADGES: Record<string, { label: string; cls: string }> = {
  accepted: { label: 'Valid', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  already_used: { label: 'Already used', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  revoked: { label: 'Revoked', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  invalid: { label: 'Invalid', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  wrong_event: { label: 'Wrong event', cls: 'bg-red-50 text-red-700 ring-red-600/20' },
  scanning_disabled: { label: 'Scanning off', cls: 'bg-brand-ice-100 text-brand-navy-700/60 ring-brand-ice-200' },
  event_closed: { label: 'Event closed', cls: 'bg-brand-ice-100 text-brand-navy-700/60 ring-brand-ice-200' },
};

function ScanBadge({ result }: { result: string }) {
  const b = SCAN_BADGES[result] ?? { label: 'Denied', cls: 'bg-red-50 text-red-700 ring-red-600/20' };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${b.cls}`}>{b.label}</span>;
}

/**
 * Multiple events can be scanning-active at the same time — activation is
 * per-event server state (src/lib/services/scanning.ts), and switching
 * which event this dashboard is *viewing* never touches any event's
 * scanningEnabled flag. This strip is the at-a-glance view across ALL of
 * them, since the header pill only ever shows the currently-viewed one
 * (owner request, 2026-09-10).
 */
function LiveEventsStrip() {
  const { eventId, select } = useSelectedEvent();
  const [events, setEvents] = useState<EventListItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      adminJson<{ ok: boolean; events: EventListItem[] }>('/api/admin/events')
        .then((r) => { if (!cancelled) setEvents(r.events ?? []); })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const live = (events ?? []).filter((e) => e.scanningEnabled);
  if (!events || live.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-brand-navy-700/40">
        Live now ({live.length})
      </span>
      {live.map((e) => (
        <button
          key={e.id}
          onClick={() => select(e.id)}
          title={e.id === eventId ? 'Currently viewing' : 'Switch to this event'}
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition ${
            e.id === eventId
              ? 'bg-emerald-500 text-white ring-emerald-500'
              : 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 hover:bg-emerald-100'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${e.id === eventId ? 'bg-white' : 'bg-emerald-500'}`} />
          {e.name}
        </button>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const { eventId } = useSelectedEvent();
  // The Activate/Deactivate control and the event's name/live status now
  // live in the header (breadcrumb + pill, on every admin page) — this page
  // no longer repeats them in a big banner, it just renders the metrics and
  // widgets underneath (owner revamp, 2026-09-10).
  const eventSummary = useEventSummary();

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

  if (!eventId) return <p className="text-brand-navy-700/60">Create or select an event first (Events page).</p>;

  const ev = eventSummary.event;

  return (
    <div className="space-y-6">
      <LiveEventsStrip />

      {eventSummary.loading ? (
        <div className={card}><Skeleton rows={2} /></div>
      ) : eventSummary.error ? (
        <div className={card}><ErrorCard message={eventSummary.error} onRetry={eventSummary.retry} /></div>
      ) : !ev ? (
        <div className={card}><p className="text-sm text-brand-navy-700/60">Event not found. It may have been removed.</p></div>
      ) : (
        <div className={`grid grid-cols-2 gap-3 sm:grid-cols-5 ${ev.totals.checkIns !== ev.totals.used ? 'lg:grid-cols-6' : ''}`}>
          <KpiCard label="Generated" value={ev.totals.generated} icon="ticket" />
          <KpiCard label="Unused" value={ev.totals.unused} icon="clock" />
          <KpiCard label="Admitted" value={ev.totals.used} icon="check" ring={{ value: ev.totals.used, total: ev.totals.generated }} />
          <KpiCard label="Revoked" value={ev.totals.revoked} icon="x" />
          <KpiCard label="Rescans allowed" value={ev.totals.rescansAllowed} icon="refresh" />
          {/* Multi-use cards (owner request, 2026-09-10): total scans admitted
              across every card, including repeat uses of one multi-use card —
              only shown once it actually differs from "Admitted" (cards fully
              exhausted), so single-use events see the same 5 cards as before. */}
          {ev.totals.checkIns !== ev.totals.used && (
            <KpiCard label="Check-ins" value={ev.totals.checkIns} icon="layers" />
          )}
        </div>
      )}

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
            <ul className="divide-y divide-brand-ice-100">
              {ushersWidget.data?.ushers.map((u) => (
                <li key={u.id} className="flex items-center gap-3 py-2">
                  <span className="relative shrink-0">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-blue-500/10 text-xs font-semibold text-brand-blue-600">
                      {initials(u.name)}
                    </span>
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${u.activeNow ? 'bg-emerald-500' : 'bg-brand-ice-200'}`}
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-brand-navy-900">
                      {u.name} {u.gateId && <span className="font-normal text-brand-navy-700/40">({u.gateId})</span>}
                    </p>
                    <p className="text-xs text-brand-navy-700/50">
                      {u.acceptedCount} admitted · last seen {fmt(u.lastSeenAt)}
                      {!u.active && <span className="ml-1.5 text-red-500">· disabled</span>}
                      {u.lockedUntil && <span className="ml-1.5 text-amber-600">· locked</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent scan activity — independent widget, proper data table */}
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
              <div className="max-h-72 overflow-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-brand-navy-700/40">
                      <th className="py-1.5 font-medium">Ticket</th>
                      <th className="py-1.5 font-medium">Usher</th>
                      <th className="py-1.5 font-medium">Status</th>
                      <th className="py-1.5 text-right font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityWidget.data?.recentScans.map((s) => (
                      <tr key={s.id} className="border-t border-brand-ice-100">
                        <td className="py-1.5">
                          {/* Tag reflected here too (owner request, 2026-09-10): a
                              family/VIP card reads as its tag, not a bare serial —
                              matching the Invitations page's Serial / Tag column. */}
                          <p className="font-semibold text-brand-navy-900">{s.tag ?? s.serialNumber ?? '—'}</p>
                          {s.tag && s.serialNumber && (
                            <p className="font-mono text-xs text-brand-navy-700/45">{s.serialNumber}</p>
                          )}
                          {typeof s.usageCount === 'number' && s.usageLimit !== 1 && (
                            <p className="text-xs text-brand-navy-700/50">
                              Use {s.usageCount}{s.usageLimit === null ? '' : ` of ${s.usageLimit}`}
                            </p>
                          )}
                        </td>
                        <td className="py-1.5 text-brand-navy-700/55">{s.usherName ?? '—'}</td>
                        <td className="py-1.5"><ScanBadge result={s.result} /></td>
                        <td className="py-1.5 text-right text-brand-navy-700/50">{fmt(s.scannedAt)}</td>
                      </tr>
                    ))}
                    {activityWidget.data?.recentScans.length === 0 && (
                      <tr><td colSpan={4} className="py-3 text-brand-navy-700/60">No scans yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Scan analytics — independent widget, same ushers data already polled above */}
      <div className={card}>
        <h2 className="mb-3 font-semibold">Scan analytics — accepted scans per usher</h2>
        {ushersWidget.loading ? (
          <Skeleton rows={4} />
        ) : ushersWidget.error ? (
          <ErrorCard message={ushersWidget.error} onRetry={ushersWidget.retry} />
        ) : (
          <UsherBarChart ushers={ushersWidget.data?.ushers ?? []} />
        )}
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
          <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
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
          </div>
        )}
      </div>
    </div>
  );
}
