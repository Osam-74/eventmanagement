'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { signOut } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';
import { useAdmin } from '@/lib/client/useAdmin';
import { adminJson } from '@/lib/client/api';

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
  const { loading, profile } = useAdmin();
  const pathname = usePathname();
  const router = useRouter();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selected, setSelected] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('selectedEventId') ?? '';
    setSelected(saved);
  }, []);

  useEffect(() => {
    if (!loading && !profile) router.replace('/login');
  }, [loading, profile, router]);

  useEffect(() => {
    if (!profile) return;
    adminJson<{ ok: boolean; events: EventItem[] }>('/api/admin/events')
      .then((r) => {
        setEvents(r.events ?? []);
        const saved = localStorage.getItem('selectedEventId');
        if (saved && r.events?.some((e) => e.id === saved)) return;
        if (r.events?.[0]) {
          localStorage.setItem('selectedEventId', r.events[0].id);
          setSelected(r.events[0].id);
          router.refresh();
        }
      })
      .catch(() => undefined);
  }, [profile, pathname]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3">
          <Link href="/admin" className="text-lg font-semibold">
            Event Access Control
          </Link>
          <select
            value={selected}
            onChange={(e) => {
              localStorage.setItem('selectedEventId', e.target.value);
              setSelected(e.target.value);
              router.refresh();
              window.location.reload();
            }}
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
              onClick={() => signOut(getFirebaseAuth())}
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
  );
}
