'use client';

import { useEffect, useState } from 'react';
import { adminFetch, adminJson } from '@/lib/client/api';
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

export default function BatchesPage() {
  const { eventId } = useSelectedEvent();
  const [batches, setBatches] = useState<Batch[]>([]);

  const load = () =>
    adminJson<{ ok: boolean; batches: Batch[] }>(`/api/admin/batches?eventId=${eventId}`)
      .then((r) => setBatches(r.batches ?? []));

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
