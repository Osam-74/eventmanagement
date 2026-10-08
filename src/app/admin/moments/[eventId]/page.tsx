'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin } from '@/lib/client/useAdmin';
import MomentsFileBrowser from '@/components/MomentsFileBrowser';
import { GuestLinkPanel } from '@/components/GuestLinkPanel';
import { SlideshowSettings } from '@/components/SlideshowSettings';

type Folder = { guestId: string; label: string; count: number; photos: number; videos: number; bytes: number; lastAt: string | null };
type EventInfo = { id: string; name: string; slug: string | null; eventDate: string | null; count: number; guestLink: string | null; guestLinkEnabled?: boolean };

const fmtSize = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function EventMomentsInner() {
  const { eventId } = useParams<{ eventId: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const { can } = useAdmin();
  const guest = search.get('guest');
  const tabParam = search.get('tab');
  const tab = tabParam === 'share' ? 'share' : tabParam === 'settings' ? 'settings' : 'files';

  const [event, setEvent] = useState<EventInfo | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const loadFolders = useCallback(async () => {
    const r = await adminJson<{ ok: boolean; folders: Folder[]; message?: string }>(`/api/admin/moments/folders?eventId=${encodeURIComponent(eventId)}`).catch(() => null);
    if (!r?.ok) {
      // Say what really happened. A missing message means the request itself failed
      // (network/server), which is NOT the same thing as "you have no access".
      setErr(r?.message ?? 'Could not reach the server to load this event. Check your connection and refresh.');
      setFolders([]); return;
    }
    setFolders(r.folders);
  }, [eventId]);

  useEffect(() => {
    setErr(''); setFolders(null);
    adminJson<{ ok: boolean; events: EventInfo[]; canShare: boolean }>('/api/admin/moments/events')
      .then((r) => { setEvent(r.events.find((e) => e.id === eventId) ?? null); setCanShare(r.canShare); })
      .catch(() => undefined);
    loadFolders();
  }, [eventId, loadFolders]);

  const go = (q: Record<string, string | null>) => {
    const p = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(q)) { if (v === null) p.delete(k); else p.set(k, v); }
    const qs = p.toString();
    router.push(`/admin/moments/${eventId}${qs ? `?${qs}` : ''}`);
  };

  if (!can('canViewMoments')) {
    return <p className="rounded-xl border border-brand-ice-200 bg-white p-6 text-sm text-brand-navy-700">You do not have access to Guest moments.</p>;
  }
  if (err) {
    return (
      <div className="space-y-3">
        <Link href="/admin/moments" className="text-sm text-brand-blue-600 hover:underline">← All events</Link>
        <p className="rounded-xl border border-brand-ice-200 bg-white p-6 text-sm text-brand-navy-700" role="alert">{err}</p>
      </div>
    );
  }

  const openFolder = folders?.find((f) => f.guestId === guest) ?? null;
  const total = folders?.reduce((n, f) => n + f.count, 0) ?? 0;

  return (
    <div className="space-y-5">
      <nav className="flex flex-wrap items-center gap-1.5 text-sm text-brand-navy-700/70" aria-label="Breadcrumb">
        <Link href="/admin/moments" className="text-brand-blue-600 hover:underline">Guest moments</Link>
        <span>/</span>
        {openFolder || guest ? (
          <>
            <button onClick={() => go({ guest: null })} className="text-brand-blue-600 hover:underline">{event?.name ?? 'Event'}</button>
            <span>/</span>
            <span className="font-medium text-brand-navy-900">{openFolder?.label ?? 'Folder'}</span>
          </>
        ) : (
          <span className="font-medium text-brand-navy-900">{event?.name ?? 'Event'}</span>
        )}
      </nav>

      <div>
        <h1 className="text-xl font-semibold text-brand-navy-900">{event?.name ?? 'Event'}</h1>
        <p className="text-sm text-brand-navy-700/70">{total} upload{total === 1 ? '' : 's'} from {folders?.length ?? 0} guest{folders?.length === 1 ? '' : 's'}</p>
      </div>

      {!guest && (
        <div className="flex gap-1 border-b border-brand-ice-200" role="tablist">
          {([['files', 'Folders'], ...(canShare ? [['share', 'Link & QR'], ['settings', 'Settings']] : [])] as [string, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k}
              onClick={() => go({ tab: k === 'files' ? null : k })}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === k ? 'border-brand-blue-500 text-brand-blue-600' : 'border-transparent text-brand-navy-700/70 hover:text-brand-navy-900'}`}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ---- Link & QR tab (only with canShareMoments) ---- */}
      {!guest && tab === 'share' && canShare && (
        event?.guestLink && event.slug
          ? <GuestLinkPanel link={event.guestLink} eventSlug={event.slug} copied={copied} setCopied={setCopied}
              eventId={eventId} enabled={event.guestLinkEnabled !== false}
              onEnabledChange={(v) => setEvent((cur) => (cur ? { ...cur, guestLinkEnabled: v } : cur))} />
          : <p className="text-sm text-brand-navy-700/60">Loading…</p>
      )}

      {/* ---- Settings tab: guest-page slideshow (only with canShareMoments) ---- */}
      {!guest && tab === 'settings' && canShare && <SlideshowSettings eventId={eventId} />}

      {/* ---- Folders tab ---- */}
      {!guest && tab === 'files' && (
        folders === null ? <p className="text-sm text-brand-navy-700/60">Loading folders…</p>
        : folders.length === 0 ? (
          <p className="rounded-xl border border-dashed border-brand-ice-200 p-10 text-center text-sm text-brand-navy-700/70">
            No uploads yet.{canShare ? ' Share the link or QR code from the “Link & QR” tab so guests can add their photos and videos.' : ''}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {folders.map((f) => (
              <li key={f.guestId}>
                <button onClick={() => go({ guest: f.guestId })}
                  className="w-full rounded-xl border border-brand-ice-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-blue-500/50 hover:shadow-md">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-brand-blue-500" aria-hidden>
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
                  </svg>
                  <p className="mt-2 font-medium text-brand-navy-900">{f.label}</p>
                  <p className="text-xs text-brand-navy-700/70">
                    {f.count} file{f.count === 1 ? '' : 's'}
                    {f.photos > 0 && ` · ${f.photos} photo${f.photos === 1 ? '' : 's'}`}
                    {f.videos > 0 && ` · ${f.videos} video${f.videos === 1 ? '' : 's'}`}
                  </p>
                  <p className="text-xs text-brand-navy-700/50">{fmtSize(f.bytes)}</p>
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      {/* ---- Inside a folder ---- */}
      {guest && (
        <>
          <button onClick={() => go({ guest: null })} className="text-sm text-brand-blue-600 hover:underline">← Back to folders</button>
          <MomentsFileBrowser eventId={eventId} guestId={guest} folderLabel={openFolder?.label} />
        </>
      )}
    </div>
  );
}

export default function EventMomentsPage() {
  return <Suspense fallback={<p className="text-sm text-brand-navy-700/60">Loading…</p>}><EventMomentsInner /></Suspense>;
}
