'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type CardType = 'regular' | 'special';

type GenResponse = {
  ok: boolean;
  batchId?: string;
  completed?: number;
  failed?: number;
  items?: { serialNumber: string; tag?: string | null }[];
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
  // Present on batches created after the Card Type feature shipped
  // (2026-09-12). Older batches have no `cardType` field at all — the
  // table below falls back to deriving it from `tag`, so nothing needs a
  // database migration.
  cardType?: CardType | null;
  tag?: string | null;
};

/**
 * Card Type is derived, never trusted blindly from the stored field alone:
 * a batch predating this feature has no `cardType`, only `tag` — resolve it
 * the same "always current, no migration needed" way as everything else in
 * this codebase (see src/lib/invitation/geometry.ts for the established
 * pattern).
 */
function resolveCardType(b: Batch): CardType {
  if (b.cardType === 'special' || b.cardType === 'regular') return b.cardType;
  return b.tag ? 'special' : 'regular';
}

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
  const [cardType, setCardType] = useState<CardType>('regular');
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState('');
  const [usageLimit, setUsageLimit] = useState(''); // empty string = unlimited uses
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

  // Card Type is the single source of truth for the tag (owner request,
  // 2026-09-12): switching back to Regular unmounts the Tag field AND
  // clears whatever was typed, so a stale value can never linger and get
  // sent by mistake if the field is re-shown later.
  function selectCardType(next: CardType) {
    setCardType(next);
    if (next === 'regular') {
      setTag('');
      setTagError('');
    }
  }

  if (!eventId) return <p className="text-brand-navy-700/60">Select an event first.</p>;

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (cardType === 'special' && !tag.trim()) {
      setTagError('Enter a tag for Special cards (e.g. VIP, FAMILY).');
      return;
    }
    setTagError('');
    setBusy(true);
    setResult(null);
    const parsedLimit = usageLimit.trim() ? parseInt(usageLimit, 10) : null;
    const r = await adminJson<GenResponse>('/api/admin/generate', {
      method: 'POST',
      body: JSON.stringify({
        eventId,
        quantity,
        profile,
        cardType,
        tag: cardType === 'special' ? tag.trim() : undefined,
        usageLimit: parsedLimit,
      }),
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
        {/* Field order (owner request, 2026-09-12): Card Type first,
            then Quantity, then the conditional Tag, then Uses per card,
            with Output profile last. */}
        {/* Card Type (owner request, 2026-09-12): Regular hides the Tag
            field entirely and defaults to standard serial-numbered cards.
            Special reveals the Tag field and requires an input (e.g. VIP,
            FAMILY) — that tag prints on the card instead of the serial. */}
        <div className="pt-0">
          <span className="text-sm text-brand-navy-800">Card Type</span>
          <div className="mt-1 flex gap-4">
            <label className="flex items-center gap-2 text-sm text-brand-navy-800">
              <input
                type="radio" name="cardType" value="regular"
                checked={cardType === 'regular'}
                onChange={() => selectCardType('regular')}
                className="h-4 w-4 accent-brand-blue-500"
              />
              Regular
            </label>
            <label className="flex items-center gap-2 text-sm text-brand-navy-800">
              <input
                type="radio" name="cardType" value="special"
                checked={cardType === 'special'}
                onChange={() => selectCardType('special')}
                className="h-4 w-4 accent-brand-blue-500"
              />
              Special
            </label>
          </div>
          <span className="mt-1 block text-xs text-brand-navy-700/50">
            Regular cards print their own serial number. Special cards print a custom tag instead (e.g. VIP, FAMILY).
          </span>
        </div>

        <div className="mt-3 grid gap-3 border-t border-brand-ice-100 pt-3 sm:grid-cols-2">
          <label className="text-sm text-brand-navy-800">
            Quantity (1–50)
            <input
              type="number" min={1} max={50} value={quantity}
              onChange={(e) => setQuantity(parseInt(e.target.value) || 1)}
              className={inputCls}
            />
          </label>
          {cardType === 'special' && (
            <label className="text-sm text-brand-navy-800">
              Tag (required — replaces the serial on the card)
              <input
                type="text" maxLength={24} value={tag} placeholder="e.g. FAMILY, VIP, USHER"
                onChange={(e) => { setTag(e.target.value); if (tagError) setTagError(''); }}
                className={inputCls}
              />
              {tagError ? (
                <span className="mt-1 block text-xs text-red-600">{tagError}</span>
              ) : (
                <span className="mt-1 block text-xs text-brand-navy-700/50">
                  Every card in this batch will print this tag instead of a serial number.
                </span>
              )}
            </label>
          )}
        </div>

        <div className="mt-3 grid gap-3 border-t border-brand-ice-100 pt-3 sm:grid-cols-2">
          <label className="text-sm text-brand-navy-800">
            Uses per card (optional)
            <input
              type="number" min={1} max={9999} value={usageLimit} placeholder="Unlimited"
              onChange={(e) => setUsageLimit(e.target.value)}
              className={inputCls}
            />
            <span className="mt-1 block text-xs text-brand-navy-700/50">
              Leave blank for unlimited uses. 1 (default) behaves exactly like today&apos;s single-use cards.
            </span>
          </label>
          <label className="text-sm text-brand-navy-800">
            Output profile
            <select value={profile} onChange={(e) => setProfile(e.target.value as 'share' | 'hq')} className={inputCls}>
              <option value="share">Share (WhatsApp/email, 3000px)</option>
              <option value="hq">HQ / archive (8K)</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          {!can('canGenerateInvites') && <p className="text-sm text-red-600">You lack the canGenerateInvites permission.</p>}
          <button
            type="submit"
            disabled={busy || !can('canGenerateInvites')}
            className="h-10 rounded-lg bg-brand-blue-500 px-6 font-medium text-white hover:bg-brand-blue-600 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
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
              {result.items?.[0]?.tag && (
                <p className="mt-1 text-sm text-brand-navy-700/70">
                  Tag printed on every card: <span className="font-semibold">{result.items[0].tag}</span>
                </p>
              )}
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
          (owner request, 2026-09-10). Redesigned into explicit columns
          (owner request, 2026-09-12): Card Type and Quantity are now their
          own sortable-looking columns instead of one grouped string. */}
      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <h2 className="border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 font-semibold text-brand-navy-900">Batches</h2>
        {batchError && (
          <p className="mx-4 mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {linkify(batchError)} <button onClick={loadBatches} className="underline">Retry</button>
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead>
              <tr className="border-b border-brand-ice-200 text-left text-xs uppercase tracking-wide text-brand-navy-700/50">
                <th className="px-4 py-2 font-medium">Card Type</th>
                <th className="px-4 py-2 font-medium">Quantity</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Date/Time</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const type = resolveCardType(b);
                return (
                  <tr key={b.id} className="border-t border-brand-ice-100 transition hover:bg-brand-ice-50/60">
                    <td className="px-4 py-2.5">
                      {type === 'special' ? (
                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                          {b.tag || 'Special'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-brand-ice-100 px-2.5 py-0.5 text-xs font-semibold text-brand-navy-700">
                          Regular
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-brand-navy-900">
                      {b.completedQuantity}/{b.requestedQuantity}
                      <span className="ml-1.5 text-xs text-brand-navy-700/50">({b.outputProfile})</span>
                      {b.failedQuantity > 0 && <span className="ml-2 text-xs text-red-600">{b.failedQuantity} failed</span>}
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
                );
              })}
              {batches.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-brand-navy-700/50">No batches yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
