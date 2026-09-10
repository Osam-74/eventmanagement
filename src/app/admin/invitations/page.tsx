'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type Invitation = {
  id: string;
  serialNumber: string;
  tag: string | null;
  usageLimit: number | null; // null = unlimited uses
  usageCount: number;
  status: 'unused' | 'used' | 'revoked';
  outputProfile: string;
  generatedAt: string | null;
  usedAt: string | null;
  usedByUsherName: string | null;
  gateId: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
  supersededByInvitationId: string | null;
  supersedesInvitationId: string | null;
  rescanAllowedAt: string | null;
  rescanAllowedBy: string | null;
  rescanHistory: { at: string | null; allowedByName: string; reason: string }[];
  recentScans?: { result: string; usherName: string | null; gateId: string | null; scannedAt: string | null }[];
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

const STATUS_STYLE: Record<string, string> = {
  unused: 'bg-emerald-100 text-emerald-800',
  used: 'bg-brand-ice-100 text-brand-navy-700',
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
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

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

  async function regenerate(inv: Invitation) {
    if (
      !confirm(
        `Regenerate the image for ${inv.serialNumber}? This issues a FRESH QR (the old one — likely already printed with a rendering bug — is revoked and can no longer be admitted). Only do this for cards not yet handed to a guest.`
      )
    )
      return;
    setRegeneratingId(inv.id);
    const r = await adminJson<{ ok: boolean; message?: string; newInvitationId?: string; imageUrl?: string }>(
      `/api/admin/invitations/${inv.id}/regenerate`,
      { method: 'POST', body: JSON.stringify({ reason: 'Regenerated from admin console — fixed rendering' }) }
    ).catch(() => null);
    setRegeneratingId(null);
    if (r?.ok) {
      setMsg(`Regenerated ${inv.serialNumber} — new card ready. Opening it now.`);
      if (r.imageUrl) window.open(r.imageUrl, '_blank');
      load(skip);
    } else {
      setMsg(r?.message ?? 'Could not regenerate this invitation.');
    }
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

  if (!eventId) return <p className="text-brand-navy-700/60">Select an event first.</p>;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
        <h2 className="mb-1 font-semibold text-brand-navy-900">Invitations — trace &amp; manage</h2>
        <p className="mb-3 text-sm text-brand-navy-700/60">
          Search by the serial number printed on the card (e.g. <code>ISWED-00042</code>) or paste a scanned QR
          credential. You&apos;ll see its status, who scanned it and when — and you can release it for a rescan
          (e.g. after a network failure at the gate).
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Serial number or scanned QR code…"
            className="min-w-[180px] flex-1 rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500"
          >
            <option value="">All statuses</option>
            <option value="unused">Unused</option>
            <option value="used">Used</option>
            <option value="revoked">Revoked</option>
          </select>
          <button onClick={() => load(0)} className="rounded-lg bg-brand-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-blue-600">
            Search
          </button>
        </div>
        {msg && <p className="mt-2 text-sm text-brand-navy-700">{msg}</p>}
      </div>

      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-brand-ice-200 bg-brand-ice-50 text-left text-xs font-semibold uppercase tracking-wide text-brand-navy-700/50">
              <th className="px-4 py-3">Serial</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Uses</th>
              <th className="px-4 py-3">Scanned by</th>
              <th className="px-4 py-3">Scanned at</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((inv) => (
              <Fragment key={inv.id}>
                <tr className="border-t border-brand-ice-100 transition hover:bg-brand-ice-50/60">
                  <td className="px-4 py-2.5">
                    {inv.tag && (
                      <span className="mr-1.5 rounded-full bg-brand-blue-500/10 px-2 py-0.5 text-xs font-semibold text-brand-blue-700">{inv.tag}</span>
                    )}
                    <span className={`font-mono font-medium text-brand-navy-900 ${inv.tag ? 'text-xs text-brand-navy-700/50' : ''}`}>{inv.serialNumber}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[inv.status]}`}>{inv.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-brand-navy-700/70">
                    {inv.usageCount}{inv.usageLimit === null ? ' (∞)' : ` / ${inv.usageLimit}`}
                  </td>
                  <td className="px-4 py-2.5 text-brand-navy-800">{inv.usageCount > 0 ? (inv.usedByUsherName ?? '—') : '—'}</td>
                  <td className="px-4 py-2.5 text-brand-navy-700/60">{inv.usageCount > 0 ? fmt(inv.usedAt) : '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={() => setExpanded(expanded === inv.id ? null : inv.id)}
                        className="rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50"
                      >
                        History
                      </button>
                      {inv.status === 'unused' && can('canManageInvites') && (
                        <button onClick={() => revoke(inv)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50">
                          Revoke
                        </button>
                      )}
                      {inv.status === 'unused' && can('canGenerateInvites') && (
                        <button
                          onClick={() => regenerate(inv)}
                          disabled={regeneratingId === inv.id}
                          title="Fixes a broken render (e.g. missing serial) by issuing a fresh QR + image. Only for cards not yet handed to a guest."
                          className="rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-50"
                        >
                          {regeneratingId === inv.id ? 'Regenerating…' : 'Regenerate image'}
                        </button>
                      )}
                      {inv.status === 'used' && can('canManageInvites') && (
                        <button onClick={() => setRescanFor(inv)} className="rounded-md bg-amber-500 px-2 py-1 text-xs font-medium text-white hover:bg-amber-600">
                          Allow rescan
                        </button>
                      )}
                      <button onClick={() => downloadCard(inv)} className="rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50">
                        Card
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded === inv.id && (
                  <tr className="bg-brand-ice-50/70">
                    <td colSpan={6} className="px-4 py-3 text-xs text-brand-navy-700/80">
                      <p>Generated: {fmt(inv.generatedAt)} · Profile: {inv.outputProfile}</p>
                      {inv.status === 'revoked' && <p className="text-red-600">Revoked: {fmt(inv.revokedAt)} — {inv.revocationReason}</p>}
                      {inv.supersededByInvitationId && (
                        <p className="text-brand-navy-700/60">Replaced by a regenerated card (id {inv.supersededByInvitationId}) — that one is the live credential now.</p>
                      )}
                      {inv.supersedesInvitationId && (
                        <p className="text-brand-navy-700/60">Regenerated to fix a broken render on a previous card (id {inv.supersedesInvitationId}).</p>
                      )}
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
              <tr><td colSpan={6} className="px-4 py-6 text-center text-brand-navy-700/50">No invitations found for this search.</td></tr>
            )}
          </tbody>
        </table>
        </div>
        {!q && (
          <div className="flex items-center gap-2 border-t border-brand-ice-200 px-4 py-3 text-sm text-brand-navy-700/60">
            <button
              disabled={skip === 0}
              onClick={() => load(Math.max(skip - 50, 0))}
              className="rounded-md border border-brand-ice-200 px-3 py-1 hover:bg-brand-ice-50 disabled:opacity-40"
            >
              Previous
            </button>
            <span>{skip}–{skip + items.length} of {total}</span>
            <button
              disabled={skip + 50 >= total}
              onClick={() => load(skip + 50)}
              className="rounded-md border border-brand-ice-200 px-3 py-1 hover:bg-brand-ice-50 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {rescanFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-navy-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-brand">
            <h3 className="text-lg font-semibold text-brand-navy-900">Allow rescan for {rescanFor.serialNumber}</h3>
            <p className="mt-1 text-sm text-brand-navy-700/70">
              Scanned by <strong>{rescanFor.usedByUsherName}</strong> at {fmt(rescanFor.usedAt)}.
              Releasing it will make this invitation valid again at the gate. This action is logged.
            </p>
            <textarea
              value={rescanReason}
              onChange={(e) => setRescanReason(e.target.value)}
              placeholder="Reason (required) — e.g. network failure at gate, scanner response lost"
              className="mt-3 h-24 w-full rounded-lg border border-brand-ice-200 bg-brand-ice-50 p-3 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setRescanFor(null)} className="rounded-lg border border-brand-ice-200 px-4 py-2 text-sm text-brand-navy-700 hover:bg-brand-ice-50">
                Cancel
              </button>
              <button
                onClick={allowRescan}
                disabled={rescanReason.trim().length < 3}
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
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
