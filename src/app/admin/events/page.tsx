'use client';

import { useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type EventItem = {
  id: string;
  name: string;
  slug: string;
  code: string;
  eventDate: string | null;
  lifecycleStatus: string;
  scanningEnabled: boolean;
  templateId: string | null;
};

type Tpl = { id: string; name: string };

export default function EventsPage() {
  const { can } = useAdmin();
  const { eventId, select } = useSelectedEvent();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [date, setDate] = useState('');
  const [msg, setMsg] = useState('');

  const load = () =>
    adminJson<{ ok: boolean; events: EventItem[] }>('/api/admin/events').then((r) => setEvents(r.events ?? []));

  useEffect(() => {
    load();
    adminJson<{ ok: boolean; templates: Tpl[] }>('/api/admin/templates').then((r) => setTemplates(r.templates ?? [])).catch(() => undefined);
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const r = await adminJson<{ ok: boolean; id?: string; message?: string }>('/api/admin/events', {
      method: 'POST',
      body: JSON.stringify({ name, slug, eventDate: new Date(date).toISOString() }),
    }).catch(() => null);
    if (r?.ok && r.id) {
      select(r.id);
      setName(''); setSlug(''); setDate('');
      load();
    } else {
      setMsg(r?.message ?? 'Could not create event.');
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await adminJson(`/api/admin/events/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    load();
  }

  return (
    <div className="space-y-6">
      {can('canManageEvents') && (
        <form onSubmit={create} className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-semibold">Create event</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <input placeholder="Event name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" required />
            <input placeholder="slug (e.g. is-wedding-2026)" value={slug} onChange={(e) => setSlug(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" required />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" required />
          </div>
          {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
          <button className="mt-3 rounded-lg bg-stone-900 px-4 py-2 text-white">Create</button>
        </form>
      )}

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-semibold">Events</h2>
        <table className="w-full text-sm">
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id} className="border-t border-stone-100">
                <td className="py-2">
                  {ev.name === events.find((x) => x.id === eventId)?.name && ev.id === eventId ? <strong>{ev.name}</strong> : ev.name}
                  <span className="ml-2 text-stone-400">{ev.slug} · {ev.code}</span>
                </td>
                <td className="py-2 text-stone-500">{ev.eventDate ? new Date(ev.eventDate).toLocaleDateString() : '—'}</td>
                <td className="py-2">
                  <select
                    value={ev.lifecycleStatus}
                    onChange={(e) => patch(ev.id, { lifecycleStatus: e.target.value })}
                    className="rounded border border-stone-300 px-2 py-1"
                  >
                    {['draft', 'open', 'closed', 'archived'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select
                    value={ev.templateId ?? ''}
                    onChange={(e) => patch(ev.id, { templateId: e.target.value || null })}
                    className="ml-2 rounded border border-stone-300 px-2 py-1"
                  >
                    <option value="">— no template —</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => select(ev.id)}
                    className={`rounded px-3 py-1 ${ev.id === eventId ? 'bg-emerald-600 text-white' : 'border border-stone-300'}`}
                  >
                    {ev.id === eventId ? 'Selected' : 'Select'}
                  </button>
                </td>
              </tr>
            ))}
            {events.length === 0 && <tr><td className="text-stone-500">No events yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
