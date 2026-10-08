'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { adminJson } from '@/lib/client/api';

/**
 * Share panel for the guest photo/video upload page: the link (copy / open)
 * and a QR that goes straight to it. The QR is rendered in the browser at a
 * print-friendly size with a quiet zone, and can be downloaded as a PNG
 * named after the event for posters and table cards.
 */
export function GuestLinkPanel({
  link, eventSlug, copied, setCopied, eventId, enabled, onEnabledChange,
}: {
  link: string; eventSlug: string; copied: boolean; setCopied: (v: boolean) => void;
  eventId: string; enabled: boolean; onEnabledChange: (v: boolean) => void;
}) {
  const [qr, setQr] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function toggle() {
    const next = !enabled;
    if (!next && !window.confirm('Deactivate the guest link? Guests who scan the QR or open the link will see "Uploads are closed". Nothing is deleted and you can turn it back on any time.')) return;
    setSaving(true); setErr('');
    try {
      const r = await adminJson<{ ok: boolean; message?: string }>(`/api/admin/moments/link?eventId=${encodeURIComponent(eventId)}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: next }),
      });
      if (r.ok) onEnabledChange(next); else setErr(r.message || 'Could not change the link. Try again.');
    } catch { setErr('Could not change the link. Check your connection and try again.'); }
    setSaving(false);
  }

  useEffect(() => {
    let live = true;
    // 1024px + 4-module quiet zone + high error correction: scans reliably
    // from a phone even when printed small or slightly worn.
    QRCode.toDataURL(link, { width: 1024, margin: 4, errorCorrectionLevel: 'H' })
      .then((u) => { if (live) setQr(u); })
      .catch(() => { if (live) setQr(''); });
    return () => { live = false; };
  }, [link]);

  return (
    <section className="rounded-xl bg-brand-ice-50 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${enabled ? 'bg-emerald-500' : 'bg-brand-navy-700/40'}`} aria-hidden="true" />
          <span className="text-sm font-medium text-brand-navy-900" role="status">{enabled ? 'Link is live' : 'Link is deactivated'}</span>
          <span className="hidden text-xs text-brand-navy-700/70 sm:inline">
            {enabled ? 'Guests can upload.' : 'Guests see "Uploads are closed".'}
          </span>
        </div>
        <button onClick={toggle} disabled={saving} role="switch" aria-checked={enabled}
          className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-60 ${enabled ? 'border border-brand-ice-200 bg-white text-brand-navy-700 hover:bg-brand-ice-50' : 'bg-brand-blue-500 text-white hover:bg-brand-blue-600'}`}>
          {saving ? 'Saving' : enabled ? 'Deactivate link' : 'Activate link'}
        </button>
        {err && <p className="w-full text-xs text-red-600" role="alert">{err}</p>}
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex h-40 w-40 shrink-0 items-center justify-center self-center rounded-lg bg-white p-2 sm:self-auto">
          {qr
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={qr} alt="QR code for the guest photo and video upload page" className="h-full w-full" />
            : <span className="text-xs text-brand-navy-700/60">Making QR…</span>}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-sm font-semibold text-brand-navy-900">Guest upload link</h2>
          <p className="text-xs text-brand-navy-700/70">
            Guests scan the QR or open the link to add their photos and videos. No sign-in needed.
          </p>
          <code className="block break-all rounded-md bg-white px-2 py-1.5 text-xs text-brand-navy-900">{link}</code>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="rounded-md border border-brand-ice-200 bg-white px-3 py-1.5 text-xs text-brand-navy-700 hover:bg-brand-ice-50"
            >{copied ? 'Copied' : 'Copy link'}</button>
            <a href={link} target="_blank" rel="noopener noreferrer"
              className="rounded-md border border-brand-ice-200 bg-white px-3 py-1.5 text-xs text-brand-navy-700 hover:bg-brand-ice-50">Open page</a>
            <a href={qr || undefined} download={`${eventSlug}-guest-moments-qr.png`} aria-disabled={!qr}
              className={`rounded-md bg-brand-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-blue-600 ${qr ? '' : 'pointer-events-none opacity-50'}`}>
              Download QR (PNG)
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
