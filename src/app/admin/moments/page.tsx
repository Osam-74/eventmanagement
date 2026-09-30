'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';
import { guestMomentsUrl } from '@/lib/moments/guestLink';
import { GuestLinkPanel } from '@/components/GuestLinkPanel';

type Moment = { id: string; kind: 'photo' | 'video'; name: string; size: number; contentType: string; createdAt: string | null; guestId: string };
type ListResp = { ok: boolean; items: Moment[]; nextCursor: string | null; total: number; configured: boolean; missing: string[]; slug: string | null };

const fmtSize = (b: number) => (b >= 1024 * 1024 * 1024 ? `${(b / 1024 / 1024 / 1024).toFixed(2)} GB` : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Admin view of everything guests uploaded for the selected event. Mark items
 * (tick boxes), then Export selected — or Export all. Thumbnails are loaded
 * on demand through short-lived signed links, never stored in the page.
 */
export default function AdminMomentsPage() {
  const { can } = useAdmin();
  const { eventId } = useSelectedEvent();
  const [items, setItems] = useState<Moment[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  const [missing, setMissing] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | 'selected' | 'all' | 'delete'>(null);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewing, setViewing] = useState<{ url: string; kind: 'photo' | 'video'; name: string } | null>(null);
  const requested = useRef<Set<string>>(new Set());

  const load = useCallback(async (after: string | null, reset: boolean) => {
    if (!eventId) return;
    const q = new URLSearchParams({ eventId });
    if (after) q.set('after', after);
    const r = await adminJson<ListResp>(`/api/admin/moments?${q}`).catch(() => null);
    if (!r?.ok) { setMsg('Could not load media.'); return; }
    setConfigured(r.configured); setMissing(r.missing); setSlug(r.slug); setTotal(r.total); setCursor(r.nextCursor);
    setItems((cur) => (reset ? r.items : [...cur, ...r.items]));
  }, [eventId]);

  useEffect(() => { setItems([]); setSelected(new Set()); setThumbs({}); requested.current = new Set(); load(null, true); }, [eventId, load]);

  // Fetch a signed thumbnail link for each visible photo once.
  useEffect(() => {
    for (const m of items) {
      if (m.kind !== 'photo' || requested.current.has(m.id)) continue;
      requested.current.add(m.id);
      adminJson<{ ok: boolean; url: string }>(`/api/admin/moments/${m.id}/url?eventId=${eventId}`)
        .then((r) => { if (r.ok) setThumbs((t) => ({ ...t, [m.id]: r.url })); })
        .catch(() => undefined);
    }
  }, [items, eventId]);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allLoadedSelected = items.length > 0 && items.every((i) => selected.has(i.id));

  async function open(m: Moment) {
    const r = await adminJson<{ ok: boolean; url: string }>(`/api/admin/moments/${m.id}/url?eventId=${eventId}`).catch(() => null);
    if (r?.ok) setViewing({ url: r.url, kind: m.kind, name: m.name });
  }

  async function doExport(mode: 'selected' | 'all') {
    setBusy(mode); setMsg(mode === 'all' ? 'Preparing your download of all media…' : 'Preparing your download…');
    try {
      const res = await fetch(
        `/api/admin/moments/export?eventId=${encodeURIComponent(eventId)}${mode === 'all' ? '&all=1' : ''}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: mode === 'selected' ? JSON.stringify({ ids: [...selected] }) : '{}' }
      );
      if (!res.ok) { const b = await res.json().catch(() => ({})); setMsg(b.message ?? 'Export failed.'); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `moments-${mode}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      setMsg(`Downloaded ${mode === 'all' ? 'all media' : `${selected.size} selected item${selected.size === 1 ? '' : 's'}`}.`);
    } catch { setMsg('Export was interrupted. Please try again.'); } finally { setBusy(null); }
  }

  async function doDelete() {
    setBusy('delete');
    const r = await adminJson<{ ok: boolean; removed?: number; message?: string }>(
      `/api/admin/moments?eventId=${encodeURIComponent(eventId)}`, { method: 'DELETE', body: JSON.stringify({ ids: [...selected] }) }
    ).catch(() => null);
    setBusy(null); setConfirmDelete(false);
    if (r?.ok) { setMsg(`Deleted ${r.removed} item${r.removed === 1 ? '' : 's'}.`); setSelected(new Set()); load(null, true); }
    else setMsg(r?.message ?? 'Could not delete.');
  }

  const guestLink = slug ? guestMomentsUrl(slug) : '';
  const canManage = can('canManageInvites');
  if (!eventId) return <p className="text-brand-navy-700">Select an event first.</p>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-brand-navy-900">Guest moments</h1>
        <p className="text-sm text-brand-navy-700/70">Photos and videos guests uploaded for this event. Nothing here counts against your Firebase storage.</p>
      </div>

      {!configured && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-medium">Cloudflare R2 is not connected yet.</p>
          <p className="mt-1">Guest uploads are switched off until these settings are added: <code>{missing.join(', ')}</code>.</p>
        </div>
      )}

      {guestLink && <GuestLinkPanel link={guestLink} eventSlug={slug!} copied={copied} setCopied={setCopied} />}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-brand-navy-700">{total} item{total === 1 ? '' : 's'}{selected.size > 0 && ` · ${selected.size} marked`}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={() => setSelected(allLoadedSelected ? new Set() : new Set(items.map((i) => i.id)))} disabled={!items.length}
            className="rounded-lg border border-brand-ice-200 px-3 py-2 text-sm text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-50">
            {allLoadedSelected ? 'Clear marks' : 'Mark all shown'}
          </button>
          <button onClick={() => doExport('selected')} disabled={!selected.size || busy !== null}
            className="rounded-lg bg-brand-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-blue-600 disabled:opacity-50">
            {busy === 'selected' ? 'Preparing…' : `Export selected${selected.size ? ` (${selected.size})` : ''}`}
          </button>
          <button onClick={() => doExport('all')} disabled={!total || busy !== null}
            className="rounded-lg border border-brand-blue-500 px-3 py-2 text-sm font-medium text-brand-blue-600 hover:bg-brand-ice-50 disabled:opacity-50">
            {busy === 'all' ? 'Preparing…' : 'Export all'}
          </button>
          {canManage && (
            <button onClick={() => setConfirmDelete(true)} disabled={!selected.size || busy !== null}
              className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">Delete marked</button>
          )}
        </div>
      </div>

      {msg && <p className="rounded-lg bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-800" role="status">{msg}</p>}

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-brand-ice-200 p-10 text-center text-sm text-brand-navy-700/70">No uploads yet. Share the guest link and they will appear here.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {items.map((m) => {
            const on = selected.has(m.id);
            return (
              <li key={m.id} className={`group relative aspect-square overflow-hidden rounded-xl bg-brand-ice-100 ring-2 ${on ? 'ring-brand-blue-500' : 'ring-transparent'}`}>
                <button onClick={() => open(m)} className="absolute inset-0 h-full w-full" aria-label={`Open ${m.name}`}>
                  {m.kind === 'photo' && thumbs[m.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbs[m.id]} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-xs font-medium text-brand-navy-700/60">{m.kind === 'video' ? '▶ Video' : 'Loading…'}</span>
                  )}
                </button>
                <label className="absolute left-1.5 top-1.5 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-white/90 shadow">
                  <input type="checkbox" checked={on} onChange={() => toggle(m.id)} aria-label={`Mark ${m.name}`} className="h-4 w-4" />
                </label>
                <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/50 px-1.5 py-0.5 text-[10px] text-white">{fmtSize(m.size)}</span>
              </li>
            );
          })}
        </ul>
      )}

      {cursor && (
        <div className="text-center">
          <button onClick={() => load(cursor, false)} className="rounded-lg border border-brand-ice-200 px-4 py-2 text-sm text-brand-navy-700 hover:bg-brand-ice-50">Load more</button>
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setViewing(null)}>
          <div className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()}>
            {viewing.kind === 'photo'
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={viewing.url} alt={viewing.name} className="max-h-[85vh] max-w-full rounded-lg" />
              : <video src={viewing.url} controls autoPlay playsInline className="max-h-[85vh] max-w-full rounded-lg" />}
            <button onClick={() => setViewing(null)} className="mt-3 w-full rounded-lg bg-white/90 py-2 text-sm font-medium text-brand-navy-900">Close</button>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-navy-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-brand">
            <h3 className="text-lg font-semibold text-brand-navy-900">Delete {selected.size} item{selected.size === 1 ? '' : 's'}?</h3>
            <p className="mt-1 text-sm text-brand-navy-700/70">This permanently removes the marked photos and videos from storage. It cannot be undone. Export them first if you want a copy.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className="rounded-lg border border-brand-ice-200 px-4 py-2 text-sm text-brand-navy-700 hover:bg-brand-ice-50">Cancel</button>
              <button onClick={doDelete} disabled={busy === 'delete'} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">{busy === 'delete' ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
