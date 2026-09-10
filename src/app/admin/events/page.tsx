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
  deleted?: boolean;
  deletedAt?: string | null;
};

type Tpl = { id: string; name: string };

export default function EventsPage() {
  const { can } = useAdmin();
  const { eventId, select } = useSelectedEvent();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [archived, setArchived] = useState<EventItem[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [date, setDate] = useState('');
  const [msg, setMsg] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    adminJson<{ ok: boolean; events: EventItem[] }>('/api/admin/events').then((r) => setEvents(r.events ?? []));
    adminJson<{ ok: boolean; events: EventItem[] }>('/api/admin/events?archived=true').then((r) => setArchived(r.events ?? []));
  };

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

  // Archiving/restoring/permanently-deleting changes which events the
  // global header switcher offers (it re-fetches on navigation, not on
  // background mutation) — a full reload keeps the switcher, dashboard and
  // this list all consistent without new cross-component plumbing.
  async function archive(ev: EventItem) {
    if (!window.confirm(`Archive "${ev.name}"? Its generated cards stop working immediately and it disappears from every list until you restore it.`)) return;
    setBusyId(ev.id);
    const r = await adminJson<{ ok: boolean; message?: string }>(`/api/admin/events/${ev.id}`, { method: 'DELETE' }).catch(() => null);
    setBusyId(null);
    if (!r?.ok) { setMsg(r?.message ?? 'Could not archive event.'); return; }
    if (ev.id === eventId) localStorage.removeItem('selectedEventId');
    window.location.reload();
  }

  async function restore(ev: EventItem) {
    setBusyId(ev.id);
    const r = await adminJson<{ ok: boolean; message?: string }>(`/api/admin/events/${ev.id}/restore`, { method: 'POST' }).catch(() => null);
    setBusyId(null);
    if (!r?.ok) { setMsg(r?.message ?? 'Could not restore event.'); return; }
    window.location.reload();
  }

  async function destroyForever(ev: EventItem) {
    const typed = window.prompt(
      `This permanently deletes "${ev.name}" and every card, batch, usher and scan log it has. This cannot be undone.\n\nType the event slug to confirm: ${ev.slug}`
    );
    if (typed === null) return;
    if (typed.trim() !== ev.slug) {
      setMsg('Slug did not match — nothing was deleted.');
      return;
    }
    setBusyId(ev.id);
    const r = await adminJson<{ ok: boolean; message?: string }>(`/api/admin/events/${ev.id}?permanent=true`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmSlug: typed.trim() }),
    }).catch(() => null);
    setBusyId(null);
    if (!r?.ok) { setMsg(r?.message ?? 'Could not permanently delete event.'); return; }
    window.location.reload();
  }

  const inputCls =
    'rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20';

  return (
    <div className="space-y-6">
      {can('canManageEvents') && (
        <form onSubmit={create} className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 font-semibold text-brand-navy-900">Create event</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <input placeholder="Event name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} required />
            <input placeholder="slug (e.g. is-wedding-2026)" value={slug} onChange={(e) => setSlug(e.target.value)} className={inputCls} required />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} required />
          </div>
          {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
          <button className="mt-3 rounded-lg bg-brand-blue-500 px-4 py-2 font-medium text-white hover:bg-brand-blue-600">Create</button>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <h2 className="border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 font-semibold text-brand-navy-900">Events</h2>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <tbody>
            {events.map((ev) => (
              <tr key={ev.id} className="border-t border-brand-ice-100 transition hover:bg-brand-ice-50/60">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-brand-navy-900">
                    {ev.name === events.find((x) => x.id === eventId)?.name && ev.id === eventId ? <strong>{ev.name}</strong> : ev.name}
                  </span>
                  <span className="ml-2 text-brand-navy-700/40">{ev.slug} · {ev.code}</span>
                </td>
                <td className="px-4 py-2.5 text-brand-navy-700/60">{ev.eventDate ? new Date(ev.eventDate).toLocaleDateString() : '—'}</td>
                <td className="px-4 py-2.5">
                  <select
                    value={ev.lifecycleStatus}
                    onChange={(e) => patch(ev.id, { lifecycleStatus: e.target.value })}
                    className="rounded-md border border-brand-ice-200 bg-brand-ice-50 px-2 py-1 text-brand-navy-900 outline-none focus:border-brand-blue-500"
                  >
                    {['draft', 'open', 'closed', 'archived'].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <select
                    value={ev.templateId ?? ''}
                    onChange={(e) => patch(ev.id, { templateId: e.target.value || null })}
                    className="ml-2 rounded-md border border-brand-ice-200 bg-brand-ice-50 px-2 py-1 text-brand-navy-900 outline-none focus:border-brand-blue-500"
                  >
                    <option value="">— no template —</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <button
                    onClick={() => select(ev.id)}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${
                      ev.id === eventId ? 'bg-brand-teal-500 text-white' : 'border border-brand-ice-200 text-brand-navy-700 hover:bg-brand-ice-50'
                    }`}
                  >
                    {ev.id === eventId ? 'Selected' : 'Select'}
                  </button>
                  {can('canManageEvents') && (
                    <button
                      onClick={() => archive(ev)}
                      disabled={busyId === ev.id}
                      className="ml-2 rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {events.length === 0 && <tr><td className="px-4 py-6 text-center text-brand-navy-700/50">No events yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </div>

      {can('canManageEvents') && (
        <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="flex w-full items-center justify-between border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 text-left font-semibold text-brand-navy-900"
          >
            <span>Archived events {archived.length > 0 && <span className="ml-1.5 rounded-full bg-brand-ice-200 px-2 py-0.5 text-xs font-normal text-brand-navy-700">{archived.length}</span>}</span>
            <span className="text-xs text-brand-navy-700/50">{showArchived ? 'Hide' : 'Show'}</span>
          </button>
          {showArchived && (
            <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <tbody>
                {archived.map((ev) => (
                  <tr key={ev.id} className="border-t border-brand-ice-100">
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-brand-navy-900/70">{ev.name}</span>
                      <span className="ml-2 text-brand-navy-700/40">{ev.slug} · {ev.code}</span>
                    </td>
                    <td className="px-4 py-2.5 text-brand-navy-700/60">
                      Archived {ev.deletedAt ? new Date(ev.deletedAt).toLocaleDateString() : ''}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => restore(ev)}
                        disabled={busyId === ev.id}
                        className="rounded-md border border-brand-ice-200 px-3 py-1 text-xs font-medium text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-50"
                      >
                        Restore
                      </button>
                      <button
                        onClick={() => destroyForever(ev)}
                        disabled={busyId === ev.id}
                        className="ml-2 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        Delete permanently
                      </button>
                    </td>
                  </tr>
                ))}
                {archived.length === 0 && <tr><td className="px-4 py-6 text-center text-brand-navy-700/50">No archived events.</td></tr>}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
