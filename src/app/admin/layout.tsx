'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { signOutAdmin } from '@/lib/client/signOut';
import { adminJson } from '@/lib/client/api';
import { useAdminWidget } from '@/lib/client/useAdminWidget';
import {
  AdminSessionProvider,
  SelectedEventProvider,
  EventSummaryProvider,
  fetchAdminSession,
  type AdminAuthzStatus,
  type AdminProfile,
  type EventSummary,
} from '@/lib/client/useAdmin';

type EventItem = { id: string; name: string; slug: string; scanningEnabled?: boolean };

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/events', label: 'Events' },
  { href: '/admin/templates', label: 'Templates' },
  { href: '/admin/generate', label: 'Generate' },
  { href: '/admin/invitations', label: 'Invitations' },
  { href: '/admin/ushers', label: 'Ushers' },
  { href: '/admin/admins', label: 'Admins' },
  { href: '/admin/logs', label: 'Scan logs' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [status, setStatus] = useState<AdminAuthzStatus>('loading');
  const [profile, setProfile] = useState<AdminProfile>(null);
  const [sessionError, setSessionError] = useState(false);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selected, setSelected] = useState('');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [confirm, setConfirm] = useState<'enable' | 'disable' | null>(null);
  const [scanningBusy, setScanningBusy] = useState(false);

  // ONE session fetch for the whole admin area (pages share it via context).
  const resolveSession = useCallback(() => {
    setSessionError(false);
    fetchAdminSession()
      .then((p) => {
        setProfile(p);
        setStatus(p ? 'authorized' : 'unauthorized');
      })
      .catch(() => setSessionError(true));
  }, []);

  useEffect(() => {
    resolveSession();
  }, [resolveSession]);

  useEffect(() => {
    if (status === 'unauthorized') router.replace('/login');
  }, [status, router]);

  useEffect(() => {
    const saved = localStorage.getItem('selectedEventId') ?? '';
    setSelected(saved);
  }, []);

  // Events list for the selector — small bounded list (≤ 100), fetched once
  // per login (the session gate above already re-runs it on full reloads).
  useEffect(() => {
    if (status !== 'authorized') return;
    adminJson<{ ok: boolean; events: EventItem[] }>('/api/admin/events')
      .then((r) => {
        setEvents(r.events ?? []);
        const saved = localStorage.getItem('selectedEventId');
        if (saved && r.events?.some((e) => e.id === saved)) return;
        if (r.events?.[0]) {
          localStorage.setItem('selectedEventId', r.events[0].id);
          setSelected(r.events[0].id);
        }
      })
      .catch(() => undefined);
  }, [status, pathname]);

  // Close the mobile drawer on every navigation.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  const selectEvent = useCallback((id: string) => {
    localStorage.setItem('selectedEventId', id);
    setSelected(id);
  }, []);

  // The selected event's live summary — ONE fetch shared by the header's
  // Activate/Deactivate control and the dashboard's status banner.
  const eventWidget = useAdminWidget<{ ok: boolean; event: EventSummary }>(
    status === 'authorized' && selected ? `/api/admin/dashboard/event?eventId=${selected}` : null,
    { pollMs: 10000 }
  );
  const ev = eventWidget.data?.event ?? null;

  async function toggleScanning(enabled: boolean) {
    setScanningBusy(true);
    await adminJson(`/api/admin/events/${selected}/scanning`, {
      method: 'POST',
      body: JSON.stringify({ enabled, confirm: true }),
    }).catch(() => undefined);
    setConfirm(null);
    setScanningBusy(false);
    eventWidget.retry();
  }

  if (status !== 'authorized' || !profile) {
    // Gate: nothing authenticated renders until the server session confirms.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-brand-ice-50 text-sm text-brand-navy-700/70">
        {sessionError ? (
          <>
            <p>Could not reach the server to confirm your session.</p>
            <button onClick={resolveSession} className="rounded-lg bg-brand-blue-500 px-4 py-2 text-white hover:bg-brand-blue-600">
              Retry
            </button>
          </>
        ) : (
          <p>Checking your session…</p>
        )}
      </main>
    );
  }

  const can = (p: string) =>
    profile?.accountType === 'ROOT_ADMIN' || Boolean(profile?.permissions?.[p]);

  const currentLabel = NAV.find((n) => n.href === pathname)?.label ?? 'Dashboard';

  const navList = (
    <nav className="flex flex-1 flex-col gap-0.5 px-3">
      {NAV.map((n) => {
        const active = pathname === n.href;
        return (
          <Link
            key={n.href}
            href={n.href}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
              active
                ? 'bg-brand-blue-500 text-white shadow-sm'
                : 'text-brand-ice-200/80 hover:bg-white/5 hover:text-white'
            }`}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );

  const sidebarFooter = (
    <div className="mt-auto border-t border-white/10 px-5 py-4">
      <p className="truncate text-xs text-brand-ice-200/60">{profile?.displayName || profile?.email}</p>
      <button
        onClick={() => signOutAdmin(() => router.replace('/'))}
        className="mt-2 w-full rounded-lg border border-white/15 py-1.5 text-xs text-brand-ice-200/80 hover:bg-white/5"
      >
        Sign out
      </button>
    </div>
  );

  const canToggleScanning = can('canManageEvents') && Boolean(selected) && Boolean(ev);

  return (
    <AdminSessionProvider value={{ status, profile, can }}>
      <SelectedEventProvider value={{ eventId: selected, select: selectEvent }}>
        <EventSummaryProvider value={{ event: ev, loading: eventWidget.loading, error: eventWidget.error, retry: eventWidget.retry }}>
          <div className="min-h-screen bg-brand-ice-50 md:flex">
            {/* Desktop sidebar — fixed left rail */}
            <aside className="hidden md:flex md:w-64 md:flex-col md:fixed md:inset-y-0 md:left-0 bg-brand-navy-900">
              <Link href="/admin" className="flex items-center gap-2.5 px-5 py-5">
                <Image src="/brand/mark.png" alt="Event Access" width={32} height={32} />
                <span className="text-sm font-semibold tracking-wide text-white">
                  EVENT<span className="text-brand-teal-400"> ACCESS</span>
                </span>
              </Link>
              {navList}
              {sidebarFooter}
            </aside>

            {/* Mobile drawer */}
            {mobileNavOpen && (
              <div className="fixed inset-0 z-40 md:hidden">
                <div className="absolute inset-0 bg-black/40" onClick={() => setMobileNavOpen(false)} />
                <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-brand-navy-900">
                  <div className="flex items-center gap-2.5 px-5 py-5">
                    <Image src="/brand/mark.png" alt="Event Access" width={32} height={32} />
                    <span className="text-sm font-semibold tracking-wide text-white">
                      EVENT<span className="text-brand-teal-400"> ACCESS</span>
                    </span>
                  </div>
                  {navList}
                  {sidebarFooter}
                </aside>
              </div>
            )}

            {/* Content column */}
            <div className="flex min-h-screen w-full flex-col md:ml-64">
              <header className="sticky top-0 z-30 border-b border-brand-ice-200 bg-white/90 backdrop-blur">
                <div className="flex flex-wrap items-center gap-3 px-4 py-3 md:px-6">
                  <button
                    onClick={() => setMobileNavOpen(true)}
                    className="rounded-lg border border-brand-ice-200 p-2 text-brand-navy-800 md:hidden"
                    aria-label="Open menu"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M3 6h18M3 12h18M3 18h18" />
                    </svg>
                  </button>
                  <h2 className="text-sm font-semibold text-brand-navy-900 md:hidden">{currentLabel}</h2>

                  {/* Breadcrumb + event switcher, merged: the event name IS the
                      context anchor now — no separate dark banner repeats it
                      lower on the page (owner revamp, 2026-09-10). */}
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <Link href="/admin/events" className="shrink-0 text-brand-navy-700/40 transition hover:text-brand-navy-700">
                      Events
                    </Link>
                    <span className="shrink-0 text-brand-navy-700/25">/</span>
                    <select
                      value={selected}
                      onChange={(e) => selectEvent(e.target.value)}
                      aria-label="Switch event"
                      className="min-w-0 max-w-[40vw] truncate rounded-md border-0 bg-transparent py-1 text-sm font-semibold text-brand-navy-900 outline-none focus:ring-2 focus:ring-brand-blue-500/30 sm:max-w-xs"
                    >
                      <option value="">Select event…</option>
                      {events.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.scanningEnabled ? '\u25CF ' : ''}{e.name}
                        </option>
                      ))}
                    </select>
                    {ev && (
                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                          ev.scanningEnabled
                            ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20'
                            : 'bg-brand-ice-100 text-brand-navy-700/55 ring-1 ring-brand-ice-200'
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            ev.scanningEnabled ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.25)]' : 'bg-brand-navy-700/25'
                          }`}
                        />
                        {ev.scanningEnabled ? 'Live' : 'Inactive'}
                      </span>
                    )}
                  </div>

                  {/* Activate/Deactivate scanning — top right of the header, on every admin page */}
                  {canToggleScanning && ev && (
                    <div className="relative ml-auto">
                      <button
                        onClick={() => setConfirm(ev.scanningEnabled ? 'disable' : 'enable')}
                        className={`rounded-lg px-4 py-1.5 text-sm font-semibold shadow-sm transition ${
                          ev.scanningEnabled
                            ? 'bg-red-50 text-red-700 hover:bg-red-100'
                            : 'bg-brand-teal-500 text-white hover:bg-brand-teal-600'
                        }`}
                      >
                        {ev.scanningEnabled ? 'Deactivate Scanning' : 'Activate Scanning'}
                      </button>
                      {confirm && (
                        <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-lg bg-white p-3 text-left text-brand-navy-900 shadow-brand ring-1 ring-black/5">
                          <p className="mb-2 text-sm font-medium">
                            {confirm === 'enable'
                              ? 'Activate scanning for this event now? Gate officials will be able to admit guests.'
                              : 'Deactivate scanning now? All gates will immediately stop admitting guests.'}
                          </p>
                          <div className="flex gap-2">
                            <button
                              disabled={scanningBusy}
                              onClick={() => toggleScanning(confirm === 'enable')}
                              className="rounded bg-brand-blue-500 px-3 py-1 text-sm text-white hover:bg-brand-blue-600 disabled:opacity-50"
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
              </header>
              <main className="flex-1 px-4 py-6 md:px-6">{children}</main>
            </div>
          </div>
        </EventSummaryProvider>
      </SelectedEventProvider>
    </AdminSessionProvider>
  );
}
