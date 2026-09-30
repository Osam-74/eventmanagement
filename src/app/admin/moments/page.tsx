'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin } from '@/lib/client/useAdmin';

type EventCard = { id: string; name: string; eventDate: string | null; count: number; guestLink: string | null };

/**
 * Guest moments home: the events THIS admin may open. The server already
 * filtered the list to their grants, so nothing here can reveal another event.
 */
export default function MomentsEventsPage() {
  const { can } = useAdmin();
  const [events, setEvents] = useState<EventCard[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    adminJson<{ ok: boolean; events: EventCard[]; message?: string }>('/api/admin/moments/events')
      .then((r) => { if (r.ok) setEvents(r.events); else setErr(r.message ?? 'Could not load events.'); })
      .catch(() => setErr('Could not load events.'));
  }, []);

  if (!can('canViewMoments')) {
    return <p className="rounded-xl border border-brand-ice-200 bg-white p-6 text-sm text-brand-navy-700">You do not have access to Guest moments.</p>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-brand-navy-900">Guest moments</h1>
        <p className="text-sm text-brand-navy-700/70">Choose an event to see the photos and videos guests uploaded, and to get its upload link and QR code.</p>
      </div>

      {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{err}</p>}
      {events === null && !err && <p className="text-sm text-brand-navy-700/60">Loading events…</p>}
      {events && events.length === 0 && (
        <p className="rounded-xl border border-dashed border-brand-ice-200 p-10 text-center text-sm text-brand-navy-700/70">
          No events available. Ask an administrator to give you access to an event.
        </p>
      )}

      {events && events.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((e) => (
            <li key={e.id}>
              <Link href={`/admin/moments/${e.id}`}
                className="block rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm transition hover:border-brand-blue-500/50 hover:shadow-md">
                <p className="truncate font-semibold text-brand-navy-900">{e.name}</p>
                <p className="mt-0.5 text-xs text-brand-navy-700/60">
                  {e.eventDate ? new Date(e.eventDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'No date'}
                </p>
                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-brand-navy-800">{e.count} upload{e.count === 1 ? '' : 's'}</span>
                  {e.guestLink && <span className="rounded-full bg-brand-ice-100 px-2 py-0.5 text-xs text-brand-navy-700">Link + QR</span>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
