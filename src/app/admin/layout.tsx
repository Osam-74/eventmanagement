'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { signOutAdmin } from '@/lib/client/signOut';
import { adminJson } from '@/lib/client/api';
import {
  AdminSessionProvider,
  SelectedEventProvider,
  fetchAdminSession,
  type AdminAuthzStatus,
  type AdminProfile,
} from '@/lib/client/useAdmin';

type EventItem = { id: string; name: string; slug: string };

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/events', label: 'Events' },
  { href: '/admin/templates', label: 'Templates' },
  { href: '/admin/generate', label: 'Generate' },
  { href: '/admin/batches', label: 'Batches' },
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

  const selectEvent = useCallback((id: string) => {
    localStorage.setItem('selectedEventId', id);
    setSelected(id);
  }, []);

  if (status !== 'authorized' || !profile) {
    // Gate: nothing authenticated renders until the server session confirms.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 text-sm text-stone-500">
        {sessionError ? (
          <>
            <p>Could not reach the server to confirm your session.</p>
            <button onClick={resolveSession} className="rounded-lg bg-stone-900 px-4 py-2 text-white">
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

  return (
    <AdminSessionProvider value={{ status, profile, can }}>
      <SelectedEventProvider value={{ eventId: selected, select: selectEvent }}>
        <div className="min-h-screen">
          <header className="border-b border-stone-200 bg-white">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
              <Link href="/admin" className="text-lg font-semibold">
                Event Access Control
              </Link>
              <select
                value={selected}
                onChange={(e) => selectEvent(e.target.value)}
                className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
              >
                <option value="">Select event…</option>
                {events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <div className="ml-auto flex items-center gap-3 text-sm text-stone-500">
                <span>{profile?.displayName || profile?.email}</span>
                <button
                  onClick={() => signOutAdmin(() => router.replace('/'))}
                  className="rounded-lg border border-stone-300 px-3 py-1.5 hover:bg-stone-50"
                >
                  Sign out
                </button>
              </div>
            </div>
            <nav className="mx-auto flex max-w-7xl flex-wrap gap-1 px-2 pb-2">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    pathname === n.href ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
                  }`}
                >
                  {n.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
        </div>
      </SelectedEventProvider>
    </AdminSessionProvider>
  );
}
