'use client';

import { useEffect, useState } from 'react';
import { adminFetch } from '@/lib/client/api';
import { useSelectedEvent } from '@/lib/client/useAdmin';

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

export default function BatchesPage() {
  const { eventId } = useSelectedEvent();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState('');

  // Deliberately not using adminJson here: it swallows non-OK responses into
  // {} on error, which previously showed as a misleading "No batches yet"
  // even when the real cause was a server error (e.g. a missing Firestore
  // composite index) — surface the actual message instead.
  const load = async () => {
    setError('');
    const res = await adminFetch(`/api/admin/batches?eventId=${eventId}`).catch(() => null);
    if (!res) { setError('Could not reach the server. Check your connection and try again.'); return; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setError(body.message ?? `Failed to load batches (HTTP ${res.status}).`); return; }
    setBatches(body.batches ?? []);
  };

  useEffect(() => { if (eventId) load(); }, [eventId]);

  if (!eventId) return <p className="text-brand-navy-700/60">Select an event first.</p>;

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

  return (
    <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
      <h2 className="border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 font-semibold text-brand-navy-900">Batches</h2>
      {error && (
        <p className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {linkify(error)} <button onClick={load} className="underline">Retry</button>
        </p>
      )}
      <table className="w-full text-sm">
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
  );
}
