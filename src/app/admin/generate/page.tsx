'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type GenResponse = {
  ok: boolean;
  batchId?: string;
  completed?: number;
  failed?: number;
  items?: { serialNumber: string }[];
  message?: string;
};

type Batch = {
  id: string;
  status: string;
  requestedQuantity: number;
  completedQuantity: number;
  failedQuantity: number;
  outputProfile: string;
  createdAt: string | null;
};

/**
 * Firestore's missing-index error embeds a direct console creation link —
 * render any URLs in the error message as clickable links.
 */
function linkify(text: string) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="break-all underline">
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

export default function GeneratePage() {
  const { can } = useAdmin();
  const { eventId } = useSelectedEvent();
  const [quantity, setQuantity] = useState(10);
  const [profile, setProfile] = useState<'share' | 'hq'>('share');
  const [result, setResult] = useState<GenResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchError, setBatchError] = useState('');

  // Deliberately not using adminJson for batches: it swallows non-OK
  // responses into {} on error, which previously showed as a misleading
  // "No batches yet" even when the real cause was a server error (e.g. a
  // missing Firestore composite index) — surface the actual message.
  const loadBatches = useCallback(async () => {
    if (!eventId) return;
    setBatchError('');
    const res = await adminFetch(`/api/admin/batches?eventId=${eventId}`).catch(() => null);
    if (!res) { setBatchError('Could not reach the server. Check your connection and try again.'); return; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setBatchError(body.message ?? `Failed to load batches (HTTP ${res.status}).`); return; }
    setBatches(body.batches ?? []);
  }, [eventId]);

  useEffect(() => { loadBatches(); }, [loadBatches]);

  if (!eventId) return <p className="text-brand-navy-700/60">Select an event first.</p>;

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const r = await adminJson<GenResponse>('/api/admin/generate', {
      method: 'POST',
      body: JSON.stringify({ eventId, quantity, profile }),
    }).catch(() => null);
    setResult(r ?? { ok: false, message: 'Generation failed.' });
    setBusy(false);
    loadBatches(); // the new batch shows up in the list below immediately
  }

  async function download(id: string) {
    const res = await adminFetch(`/api/admin/batches/${id}/download`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `batch-${id}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls =
    'mt-1 w-full rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20';

  return (
    <div className="max-w-3xl space-y-6">
      <form onSubmit={generate} className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-semibold text-brand-navy-900">Generate invitation cards</h2>
        <p className="mb-3 text-sm text-brand-navy-700/60">
          Each card receives a unique cryptographically random QR credential and a traceable serial number
          printed on the card. Generated on demand — never pre-generated.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm text-brand-navy-800">
            Quantity (1–50)
            <input
              type="number" min={1} max={50} value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
              className={inputCls}
            />
          </label>
          <label className="text-sm text-brand-navy-800">
            Output profile
            <select value={profile} onChange={(e) => setProfile(e.target.value as 'share' | 'hq')} className={inputCls}>
              <option value="share">Share (WhatsApp/email, 3000px)</option>
              <option value="hq">HQ / archive (8K)</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={busy || !can('canGenerateInvites')}
            className="mt-6 h-10 rounded-lg bg-brand-blue-500 px-4 font-medium text-white hover:bg-brand-blue-600 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {!can('canGenerateInvites') && <p className="mt-2 text-sm text-red-600">You lack the canGenerateInvites permission.</p>}
      </form>

      {result && (
        <div className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
          {result.ok ? (
            <>
              <p className="font-medium text-emerald-700">
                Generated {result.completed} card(s){result.failed ? `, ${result.failed} failed` : ''}.
              </p>
              <p className="mt-1 text-sm text-brand-navy-700/60">
                Batch <code>{result.batchId}</code> — download it from the list below.
              </p>
              <p className="mt-2 text-xs text-brand-navy-700/60">
                Serials: {result.items?.slice(0, 10).map((i) => i.serialNumber).join(', ')}
                {(result.items?.length ?? 0) > 10 ? ' …' : ''}
              </p>
            </>
          ) : (
            <p className="font-medium text-red-700">{result.message ?? 'Generation failed.'}</p>
          )}
        </div>
      )}

      {/* Batches — merged onto this page so generate + download live together
          (owner request, 2026-09-10). */}
      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <h2 className="border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 font-semibold text-brand-navy-900">Batches</h2>
        {batchError && (
          <p className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {linkify(batchError)} <button onClick={loadBatches} className="underline">Retry</button>
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-t border-brand-ice-100 transition hover:bg-brand-ice-50/60">
                  <td className="px-4 py-2.5 text-brand-navy-900">
                    {b.completedQuantity}/{b.requestedQuantity} cards ({b.outputProfile})
                    {b.failedQuantity > 0 && <span className="ml-2 text-red-600">{b.failedQuantity} failed</span>}
                  </td>
                  <td className="px-4 py-2.5 text-brand-navy-700/60">{b.status}</td>
                  <td className="px-4 py-2.5 text-brand-navy-700/60">{b.createdAt ? new Date(b.createdAt).toLocaleString() : ''}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      onClick={() => download(b.id)}
                      disabled={b.completedQuantity === 0}
                      className="rounded-md border border-brand-ice-200 px-3 py-1 text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-40"
                    >
                      Download ZIP
                    </button>
                  </td>
                </tr>
              ))}
              {batches.length === 0 && <tr><td className="px-4 py-6 text-center text-brand-navy-700/50">No batches yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
