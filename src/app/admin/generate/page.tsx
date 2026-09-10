'use client';

import { useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type GenResponse = {
  ok: boolean;
  batchId?: string;
  completed?: number;
  failed?: number;
  items?: { serialNumber: string }[];
  message?: string;
};

export default function GeneratePage() {
  const { can } = useAdmin();
  const { eventId } = useSelectedEvent();
  const [quantity, setQuantity] = useState(10);
  const [profile, setProfile] = useState<'share' | 'hq'>('share');
  const [result, setResult] = useState<GenResponse | null>(null);
  const [busy, setBusy] = useState(false);

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
  }

  const inputCls =
    'mt-1 w-full rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20';

  return (
    <div className="max-w-xl space-y-6">
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
                Batch <code>{result.batchId}</code> — download it from the Batches page.
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
    </div>
  );
}
