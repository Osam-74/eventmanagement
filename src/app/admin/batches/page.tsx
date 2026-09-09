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

  if (!eventId) return <p className="text-stone-500">Select an event first.</p>;

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
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <h2 className="mb-3 font-semibold">Batches</h2>
      {error && (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {linkify(error)} <button onClick={load} className="underline">Retry</button>
        </p>
      )}
      <table className="w-full text-sm">
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className="border-t border-stone-100">
              <td className="py-2">
                {b.completedQuantity}/{b.requestedQuantity} cards ({b.outputProfile})
                {b.failedQuantity > 0 && <span className="ml-2 text-red-600">{b.failedQuantity} failed</span>}
              </td>
              <td className="py-2 text-stone-500">{b.status}</td>
              <td className="py-2 text-stone-500">{b.createdAt ? new Date(b.createdAt).toLocaleString() : ''}</td>
              <td className="py-2 text-right">
                <button
                  onClick={() => download(b.id)}
                  disabled={b.completedQuantity === 0}
                  className="rounded border border-stone-300 px-3 py-1 disabled:opacity-40"
                >
                  Download ZIP
                </button>
              </td>
            </tr>
          ))}
          {batches.length === 0 && <tr><td className="text-stone-500">No batches yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
