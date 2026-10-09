'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { GuestSlideshowBackground } from '@/components/GuestSlideshowBackground';
import { CONCURRENCY, getGuestId, getSavedGuestName, saveGuestName, runPool, uploadOne, type Started } from '@/lib/client/momentsUpload';
import { cleanGuestName, MAX_GUEST_NAME } from '@/lib/moments/rules';

/**
 * Public guest page: ONE upload area and nothing else. Tapping it opens the
 * phone's gallery with multi-select. Thumbnails are made from the local file
 * and kept in React state only, so they are gone on refresh (by design).
 */
type Item = {
  key: string;
  name: string;
  kind: 'photo' | 'video';
  previewUrl: string; // local blob URL for instant thumbnails
  status: 'queued' | 'uploading' | 'done' | 'error';
  progress: number;
  message?: string;
};

const ACCEPT = 'image/*,video/*,.heic,.heif,.mov';
const MAX_MB = 100;

export default function MomentsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [items, setItems] = useState<Item[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [event, setEvent] = useState<{ name: string } | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [slides, setSlides] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [guestName, setGuestName] = useState('');
  const guestIdRef = useRef<string>('');
  const guestNameRef = useRef('');
  const urlsRef = useRef<string[]>([]);

  useEffect(() => {
    guestIdRef.current = getGuestId();
    const saved = getSavedGuestName();
    setGuestName(saved); guestNameRef.current = saved;
    fetch(`/api/moments/${encodeURIComponent(slug)}/info`)
      .then((r) => r.json())
      .then((b) => {
        if (b.ok) { setEvent({ name: b.name }); setSlides(Array.isArray(b.slides) ? b.slides.map((x: { url: string }) => x.url) : []); if (!b.open) setClosed('Uploads are closed for this event.'); }
        else setClosed('This upload link is not valid.');
      })
      .catch(() => undefined);
    return () => urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
  }, [slug]);

  const patch = useCallback((key: string, p: Partial<Item>) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...p } : i))), []);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow picking the same file again
    if (!files.length) return;
    setNotice(null);
    // Commit whatever is in the box now (the field may not have lost focus yet).
    const name = cleanGuestName(guestNameRef.current);
    setGuestName(name); guestNameRef.current = name; saveGuestName(name);

    const fresh: Item[] = files.map((f, i) => {
      const url = URL.createObjectURL(f);
      urlsRef.current.push(url);
      return {
        key: `${Date.now()}-${i}-${f.name}`, name: f.name,
        kind: f.type.startsWith('video') || /\.(mov|mp4|webm|3gp)$/i.test(f.name) ? 'video' : 'photo',
        previewUrl: url, status: 'queued', progress: 0,
      };
    });
    setItems((cur) => [...fresh, ...cur]);

    // Server signs in batches of 20 (its limit) and rejects anything not allowed.
    for (let off = 0; off < files.length; off += 20) {
      const batch = files.slice(off, off + 20);
      const keys = fresh.slice(off, off + 20).map((f) => f.key);
      let started: Started[] = [];
      try {
        const res = await fetch(`/api/moments/${encodeURIComponent(slug)}/start`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guestId: guestIdRef.current, guestName: name, files: batch.map((f) => ({ name: f.name, type: f.type, size: f.size })) }),
        });
        const body = await res.json();
        if (!body.ok) { keys.forEach((k) => patch(k, { status: 'error', message: body.message })); setNotice(body.message); continue; }
        started = body.uploads as Started[];
      } catch {
        keys.forEach((k) => patch(k, { status: 'error', message: 'No connection. Try again.' }));
        continue;
      }

      await runPool(batch, CONCURRENCY, async (file, i) => {
        const s = started[i];
        const key = keys[i];
        if (!s || !s.ok) { patch(key, { status: 'error', message: s && !s.ok ? s.message : 'Could not start' }); return; }
        patch(key, { status: 'uploading' });
        const out = await uploadOne(slug, guestIdRef.current, file, s, (p) => patch(key, { progress: Math.min(p, 1) }));
        if (out.ok) patch(key, { status: 'done', progress: 1 });
        else patch(key, { status: 'error', message: out.message });
      });
    }
  }

  const done = items.filter((i) => i.status === 'done').length;
  const busy = items.some((i) => i.status === 'queued' || i.status === 'uploading');

  const bg = slides.length > 0; // over photos: white text + frosted panels for legibility

  return (
    <>
    <GuestSlideshowBackground urls={slides} />
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-4 pb-10 pt-8">
      {event && (
        <p className="mx-auto mb-4 max-w-full rounded-full bg-white px-5 py-2 text-center text-base font-semibold text-green-700 shadow-md">{event.name}</p>
      )}

      {closed ? (
        <p className={`mt-16 text-center ${bg ? 'rounded-2xl bg-black/50 px-4 py-6 text-white backdrop-blur' : 'text-brand-navy-800'}`}>{closed}</p>
      ) : (
        <>
          <div className={`mb-4 rounded-2xl px-4 py-3 ${bg ? 'bg-white/90 backdrop-blur' : 'border border-brand-ice-200 bg-white'}`}>
            <label htmlFor="guest-name" className="block text-sm font-medium text-brand-navy-900">
              Your name <span className="font-normal text-brand-navy-700/60">(optional)</span>
            </label>
            <input
              id="guest-name"
              type="text"
              inputMode="text"
              autoComplete="name"
              maxLength={MAX_GUEST_NAME}
              value={guestName}
              onChange={(e) => { setGuestName(e.target.value); guestNameRef.current = e.target.value; }}
              onBlur={() => { const c = cleanGuestName(guestName); setGuestName(c); guestNameRef.current = c; saveGuestName(c); }}
              placeholder="So the hosts know whose photos these are"
              className="mt-1 w-full rounded-lg border border-brand-ice-200 px-3 py-2 text-base text-brand-navy-900 placeholder:text-brand-navy-700/40 focus:border-brand-blue-500 focus:outline-none focus:ring-2 focus:ring-brand-blue-500/30"
            />
          </div>
          <input ref={inputRef} type="file" accept={ACCEPT} multiple onChange={onPick} className="sr-only" aria-label="Choose photos and videos" />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={`flex w-full flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-6 py-14 text-center transition active:scale-[0.99] ${bg ? 'border-white/70 bg-white/85 backdrop-blur-md active:bg-white' : 'border-brand-blue-500/50 bg-brand-ice-50 active:bg-white'}`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-12 w-12 text-brand-blue-500" aria-hidden>
              <path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M20 16v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3" />
            </svg>
            <span className="text-lg font-semibold text-brand-navy-900">Upload photos &amp; videos</span>
            <span className="text-sm text-brand-navy-700/70">Tap to choose from your gallery. Select as many as you like (up to {MAX_MB} MB each).</span>
          </button>

          {notice && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{notice}</p>}

          {items.length > 0 && (
            <>
              <p className={`mt-6 text-sm ${bg ? 'rounded-lg bg-black/50 px-3 py-2 text-white backdrop-blur' : 'text-brand-navy-700'}`} aria-live="polite">
                {busy ? `Uploading… ${done} of ${items.length} done. Please keep this page open.` : `${done} of ${items.length} uploaded. Thank you!`}
              </p>
              <ul className="mt-3 grid grid-cols-3 gap-2">
                {items.map((it) => (
                  <li key={it.key} className="relative aspect-square overflow-hidden rounded-xl bg-brand-ice-100">
                    {it.kind === 'photo' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.previewUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <video src={it.previewUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                    )}
                    {it.kind === 'video' && (
                      <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">VIDEO</span>
                    )}
                    {(it.status === 'uploading' || it.status === 'queued') && (
                      <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/25">
                        <div className="h-full bg-brand-blue-500 transition-[width]" style={{ width: `${Math.round(it.progress * 100)}%` }} />
                      </div>
                    )}
                    {it.status === 'done' && (
                      <span className="absolute bottom-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white" aria-label="Uploaded">
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
                      </span>
                    )}
                    {it.status === 'error' && (
                      <div className="absolute inset-0 flex items-center justify-center bg-red-600/80 p-1.5 text-center text-[11px] font-medium leading-tight text-white">
                        {it.message ?? 'Failed'}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </main>
    </>
  );
}
