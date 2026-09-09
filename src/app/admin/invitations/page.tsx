'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type Invitation = {
  id: string;
  serialNumber: string;
  status: 'unused' | 'used' | 'revoked';
  outputProfile: string;
  generatedAt: string | null;
  usedAt: string | null;
  usedByUsherName: string | null;
  gateId: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  rescanAllowedAt: string | null;
  rescanAllowedBy: string | null;
  rescanHistory: { at: string | null; allowedByName: string; reason: string }[];
  recentScans?: { result: string; usherName: string | null; gateId: string | null; scannedAt: string | null }[];
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

const STATUS_STYLE: Record<string, string> = {
  unused: 'bg-emerald-100 text-emerald-800',
  used: 'bg-stone-200 text-stone-700',
  revoked: 'bg-red-100 text-red-700',
};

export default function InvitationsPage() {
  const { can } = useAdmin();
  const { eventId } = useSelectedEvent();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<Invitation[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [msg, setMsg] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rescanFor, setRescanFor] = useState<Invitation | null>(null);
  const [rescanReason, setRescanReason] = useState('');

  const load = useCallback(
    async (offset = 0) => {
      if (!eventId) return;
      const params = new URLSearchParams({ eventId, limit: '50', skip: String(offset) });
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      const r = await adminJson<{ ok: boolean; items: Invitation[]; total: number }>(
        `/api/admin/invitations?${params.toString()}`
      ).catch(() => null);
      if (r?.ok) {
        setItems(r.items);
        setTotal(r.total);
        setSkip(offset);
      }
    },
    [eventId, q, status]
  );

  useEffect(() => { load(0); }, [load]);

  async function revoke(inv: Invitation) {
    if (!confirm(`Revoke invitation ${inv.serialNumber}? It can never be admitted afterwards.`)) return;
    await adminJson(`/api/admin/invitations/${inv.id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Revoked from admin console' }),
    });
    setMsg(`Revoked ${inv.serialNumber}.`);
    load(skip);
  }

  async function allowRescan() {
    if (!rescanFor) return;
    const r = await adminJson<{ ok: boolean; message?: string }>(
      `/api/admin/invitations/${rescanFor.id}/allow-rescan`,
      { method: 'POST', body: JSON.stringify({ reason: rescanReason }) }
    ).catch(() => null);
    if (r?.ok) {
      setMsg(`${rescanFor.serialNumber} released for rescan. The gate can scan it again now.`);
      setRescanFor(null);
      setRescanReason('');
      load(skip);
    } else {
      setMsg(r?.message ?? 'Could not release for rescan.');
      setRescanFor(null);
    }
  }

  async function downloadCard(inv: Invitation) {
    const r = await adminJson<{ ok: boolean; url?: string }>(`/api/admin/invitations/${inv.id}/image`);
    if (r?.url) window.open(r.url, '_blank');
  }

  if (!eventId) return <p className="text-stone-500">Select an event first.</p>;

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-1 font-semibold">Invitations — trace &amp; manage</h2>
        <p className="mb-3 text-sm text-stone-500">
          Search by the serial number printed on the card (e.g. <code>ISWED-00042</code>) or paste a scanned QR
          credential. You&apos;ll see its status, who scanned it and when — and you can release it for a rescan
          (e.g. after a network failure at the gate).
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Serial number or scanned QR code…"
            className="min-w-[260px] flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm"
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">
            <option value="">All statuses</option>
            <option value="unused">Unused</option>
            <option value="used">Used</option>
            <option value="revoked">Revoked</option>
          </select>
          <button onClick={() => load(0)} className="rounded-lg bg-stone-900 px-4 py-2 text-sm text-white">
            Search
          </button>
        </div>
        {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
      </div>

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-stone-400">
              <th className="py-2">Serial</th>
              <th className="py-2">Status</th>
              <th className="py-2">Scanned by</th>
              <th className="py-2">Scanned at</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((inv) => (
              <Fragment key={inv.id}>
                <tr className="border-t border-stone-100">
                  <td className="py-2 font-mono font-medium">{inv.serialNumber}</td>
                  <td className="py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[inv.status]}`}>{inv.status}</span>
                  </td>
                  <td className="py-2">{inv.status === 'used' ? (inv.usedByUsherName ?? '—') : '—'}</td>
                  <td className="py-2 text-stone-500">{inv.status === 'used' ? fmt(inv.usedAt) : '—'}</td>
                  <td className="py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setExpanded(expanded === inv.id ? null : inv.id)} className="rounded border border-stone-300 px-2 py-1 text-xs">
                        History
                      </button>
                      {inv.status === 'unused' && can('canManageInvites') && (
                        <button onClick={() => revoke(inv)} className="rounded border border-red-300 px-2 py-1 text-xs text-red-700">
                          Revoke
                        </button>
                      )}
                      {inv.status === 'used' && can('canManageInvites') && (
                        <button onClick={() => setRescanFor(inv)} className="rounded bg-amber-500 px-2 py-1 text-xs font-medium text-white">
                          Allow rescan
                        </button>
                      )}
                      <button onClick={() => downloadCard(inv)} className="rounded border border-stone-300 px-2 py-1 text-xs">
                        Card
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded === inv.id && (
                  <tr className="bg-stone-50">
                    <td colSpan={5} className="py-3 text-xs text-stone-600">
                      <p>Generated: {fmt(inv.generatedAt)} · Profile: {inv.outputProfile}</p>
                      {inv.status === 'revoked' && <p className="text-red-600">Revoked: {fmt(inv.revokedAt)} — {inv.revocationReason}</p>}
                      {inv.rescanHistory.map((h, i) => (
                        <p key={i} className="text-amber-700">
                          Rescan allowed: {fmt(h.at)} by {h.allowedByName} — {h.reason}
                        </p>
                      ))}
                      {inv.recentScans?.map((s, i) => (
                        <p key={`s${i}`}>
                          Scan attempt: {s.result} · {s.usherName} · {s.gateId ?? ''} · {fmt(s.scannedAt)}
                        </p>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="py-4 text-stone-500">No invitations found for this search.</td></tr>
            )}
          </tbody>
        </table>
        {!q && (
          <div className="mt-3 flex items-center gap-2 text-sm text-stone-500">
            <button disabled={skip === 0} onClick={() => load(Math.max(skip - 50, 0))} className="rounded border border-stone-300 px-3 py-1 disabled:opacity-40">
              Previous
            </button>
            <span>{skip}–{skip + items.length} of {total}</span>
            <button disabled={skip + 50 >= total} onClick={() => load(skip + 50)} className="rounded border border-stone-300 px-3 py-1 disabled:opacity-40">
              Next
            </button>
          </div>
        )}
      </div>

      {rescanFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold">Allow rescan for {rescanFor.serialNumber}</h3>
            <p className="mt-1 text-sm text-stone-600">
              Scanned by <strong>{rescanFor.usedByUsherName}</strong> at {fmt(rescanFor.usedAt)}.
              Releasing it will make this invitation valid again at the gate. This action is logged.
            </p>
            <textarea
              value={rescanReason}
              onChange={(e) => setRescanReason(e.target.value)}
              placeholder="Reason (required) — e.g. network failure at gate, scanner response lost"
              className="mt-3 h-24 w-full rounded-lg border border-stone-300 p-3 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setRescanFor(null)} className="rounded-lg border border-stone-300 px-4 py-2 text-sm">
                Cancel
              </button>
              <button
                onClick={allowRescan}
                disabled={rescanReason.trim().length < 3}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Release for rescan
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
