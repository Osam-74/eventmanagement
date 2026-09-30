'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminJson } from '@/lib/client/api';

/**
 * Settings tab: the photos that slide across the background of this event's
 * guest upload page. Big camera photos are shrunk in the browser first (long
 * edge 2000px, JPEG), so a full-size batch uploads quickly on mobile data and
 * always fits the server's limit.
 */
type Slide = { id: string; name: string; url: string };
type Started = { ok: true; id: string; key: string; url: string; contentType: string } | { ok: false; message: string };

const LONG_EDGE = 2000;

async function shrink(file: File): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= 3 * 1024 * 1024) { bmp.close(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

export function SlideshowSettings({ eventId }: { eventId: string }) {
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [max, setMax] = useState(60);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const q = `eventId=${encodeURIComponent(eventId)}`;

  const load = useCallback(async () => {
    const r = await adminJson<{ ok: boolean; slides: Slide[]; max: number; configured: boolean; message?: string }>(`/api/admin/moments/slides?${q}`).catch(() => null);
    if (!r?.ok) { setMsg({ kind: 'err', text: r?.message ?? 'Could not load the slideshow photos.' }); setSlides([]); return; }
    setSlides(r.slides); setMax(r.max); setConfigured(r.configured);
  }, [q]);
  useEffect(() => { load(); }, [load]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!picked.length) return;
    setMsg(null);
    let added = 0; const problems: string[] = [];
    for (let off = 0; off < picked.length; off += 20) {
      const chunk = picked.slice(off, off + 20);
      setBusy(`Preparing ${Math.min(off + chunk.length, picked.length)} of ${picked.length}…`);
      const files = await Promise.all(chunk.map(shrink));
      const start = await adminJson<{ ok: boolean; uploads: Started[]; message?: string }>(`/api/admin/moments/slides?${q}`, {
        method: 'POST', body: JSON.stringify({ action: 'start', files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) }),
      }).catch(() => null);
      if (!start?.ok) { problems.push(start?.message ?? 'Could not start the upload.'); break; }
      const done: { id: string; key: string; name: string }[] = [];
      let n = 0;
      await Promise.all(start.uploads.map(async (u, i) => {
        if (!u.ok) { problems.push(u.message); return; }
        try {
          const res = await fetch(u.url, { method: 'PUT', headers: { 'Content-Type': u.contentType }, body: files[i] });
          if (!res.ok) throw new Error(String(res.status));
          done.push({ id: u.id, key: u.key, name: files[i].name });
        } catch { problems.push(`${files[i].name} could not be uploaded.`); }
        setBusy(`Uploading ${off + ++n} of ${picked.length}…`);
      }));
      if (done.length) {
        const fin = await adminJson<{ ok: boolean; added: number; rejected: number }>(`/api/admin/moments/slides?${q}`, {
          method: 'POST', body: JSON.stringify({ action: 'complete', items: done }),
        }).catch(() => null);
        if (fin?.ok) { added += fin.added; if (fin.rejected) problems.push(`${fin.rejected} file${fin.rejected === 1 ? ' was' : 's were'} rejected.`); }
        else problems.push('Some photos uploaded but could not be saved. Refresh and check.');
      }
    }
    setBusy(null);
    setMsg(problems.length
      ? { kind: added ? 'ok' : 'err', text: `${added} added. ${problems.slice(0, 3).join(' ')}` }
      : { kind: 'ok', text: `${added} photo${added === 1 ? '' : 's'} added. Guests see them the next time they open the page.` });
    load();
  }

  async function remove(s: Slide) {
    if (!window.confirm('Remove this photo from the slideshow?')) return;
    setBusy('Removing…');
    const r = await adminJson<{ ok: boolean }>(`/api/admin/moments/slides?${q}&id=${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch(() => null);
    setBusy(null);
    if (!r?.ok) { setMsg({ kind: 'err', text: 'Could not remove that photo.' }); return; }
    setSlides((cur) => (cur ?? []).filter((x) => x.id !== s.id));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-brand-navy-900">Guest page slideshow</h2>
        <p className="text-sm text-brand-navy-700/70">These photos slide across the full-screen background of the guest upload page. Up to {max}.</p>
      </div>

      {!configured && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800" role="alert">Photo storage (R2) is not connected yet, so photos cannot be added.</p>}

      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={onPick} className="sr-only" aria-label="Choose slideshow photos" />
      <button type="button" disabled={!configured || busy !== null} onClick={() => input.current?.click()}
        className="rounded-md bg-brand-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-blue-600 disabled:opacity-50">
        {busy ?? 'Add photos'}
      </button>

      {msg && <p role={msg.kind === 'err' ? 'alert' : 'status'} className={`rounded-lg px-3 py-2 text-sm ${msg.kind === 'err' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>{msg.text}</p>}

      {slides === null ? <p className="text-sm text-brand-navy-700/60">Loading…</p>
        : slides.length === 0 ? <p className="rounded-xl border border-dashed border-brand-ice-200 p-8 text-center text-sm text-brand-navy-700/70">No slideshow photos yet. Add some and they will play behind the guest upload page.</p>
        : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {slides.map((s) => (
              <li key={s.id} className="group relative aspect-[3/4] overflow-hidden rounded-lg bg-brand-ice-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.url} alt={s.name} className="h-full w-full object-cover" loading="lazy" />
                <button type="button" onClick={() => remove(s)} disabled={busy !== null} aria-label={`Remove ${s.name}`}
                  className="absolute right-1 top-1 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
