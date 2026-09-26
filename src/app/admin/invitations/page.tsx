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

// Icon-only action buttons (see the Actions column below) — each pairs a
// small inline SVG with a title/aria-label so the action stays labeled for
// tooltips and screen readers even without visible text.
const ICON_BASE = 'h-4 w-4';
function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON_BASE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}
function RevokeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON_BASE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.5 5.5l13 13" />
    </svg>
  );
}
function RegenerateIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${ICON_BASE} ${spinning ? 'animate-spin' : ''}`}
    >
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function RescanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON_BASE}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
  );
}
function ViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON_BASE}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={ICON_BASE}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<Invitation[] | null>(null);
  const [deleting, setDeleting] = useState(false);

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
        setSelected(new Set());
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

  async function viewCard(inv: Invitation) {
    const r = await adminJson<{ ok: boolean; url?: string }>(`/api/admin/invitations/${inv.id}/image`);
    if (r?.url) window.open(r.url, '_blank');
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))));
  }

  async function confirmDelete() {
    if (!deleteTargets || deleteTargets.length === 0) return;
    setDeleting(true);
    const r = await adminJson<{ ok: boolean; deleted?: number; skipped?: number; message?: string }>(
      '/api/admin/invitations',
      {
        method: 'DELETE',
        body: JSON.stringify({
          invitationIds: deleteTargets.map((i) => i.id),
          reason: deleteTargets.length > 1 ? 'Batch deleted from admin console' : 'Deleted from admin console',
        }),
      }
    ).catch(() => null);
    setDeleting(false);
    setDeleteTargets(null);
    if (r?.ok) {
      setMsg(
        deleteTargets.length > 1
          ? `Deleted ${r.deleted ?? deleteTargets.length} invitation(s) and their stored card images.`
          : `Deleted ${deleteTargets[0].serialNumber} and its stored card image.`
      );
      setSelected(new Set());
      load(skip);
    } else {
      setMsg(r?.message ?? 'Could not delete the selected invitation(s).');
    }
  }

  if (!eventId) return <p className="text-brand-navy-700/60">Select an event first.</p>;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
        <h2 className="mb-1 font-semibold text-brand-navy-900">Invitations — trace &amp; manage</h2>
        <p className="mb-3 text-sm text-brand-navy-700/60">
          Search by the serial number printed on the card (e.g. <code>ISWED-00042</code>) or paste a scanned QR
          credential.
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

      {selected.size > 0 && can('canManageInvites') && (
        <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm font-medium text-red-800">{selected.size} invitation(s) selected</p>
          <button
            onClick={() => setDeleteTargets(items.filter((i) => selected.has(i.id)))}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Delete selected
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-brand-ice-200 bg-brand-ice-50 text-left text-xs font-semibold uppercase tracking-wide text-brand-navy-700/50">
              {can('canManageInvites') && (
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={items.length > 0 && selected.size === items.length}
                    onChange={toggleSelectAll}
                    aria-label="Select all invitations on this page"
                  />
                </th>
              )}
              <th className="px-4 py-3">Serial / Tag</th>
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
                  {can('canManageInvites') && (
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(inv.id)}
                        onChange={() => toggleSelect(inv.id)}
                        aria-label={`Select ${inv.serialNumber}`}
                      />
                    </td>
                  )}
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
                        title="History"
                        aria-label="View history"
                        className="rounded-md border border-brand-ice-200 p-1.5 text-brand-navy-700 hover:bg-brand-ice-50"
                      >
                        <HistoryIcon />
                      </button>
                      {inv.status === 'unused' && can('canManageInvites') && (
                        <button
                          onClick={() => revoke(inv)}
                          title="Revoke"
                          aria-label="Revoke invitation"
                          className="rounded-md border border-red-200 p-1.5 text-red-700 hover:bg-red-50"
                        >
                          <RevokeIcon />
                        </button>
                      )}
                      {inv.status === 'unused' && can('canGenerateInvites') && (
                        <button
                          onClick={() => regenerate(inv)}
                          disabled={regeneratingId === inv.id}
                          title={
                            regeneratingId === inv.id
                              ? 'Regenerating…'
                              : 'Regenerate image — fixes a broken render (e.g. missing serial) by issuing a fresh QR + image. Only for cards not yet handed to a guest.'
                          }
                          aria-label="Regenerate image"
                          className="rounded-md border border-brand-ice-200 p-1.5 text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-50"
                        >
                          <RegenerateIcon spinning={regeneratingId === inv.id} />
                        </button>
                      )}
                      {inv.status === 'used' && can('canManageInvites') && (
                        <button
                          onClick={() => setRescanFor(inv)}
                          title="Allow rescan"
                          aria-label="Allow rescan"
                          className="rounded-md bg-amber-500 p-1.5 text-white hover:bg-amber-600"
                        >
                          <RescanIcon />
                        </button>
                      )}
                      <button
                        onClick={() => viewCard(inv)}
                        title="View card"
                        aria-label="View card"
                        className="rounded-md border border-brand-ice-200 p-1.5 text-brand-navy-700 hover:bg-brand-ice-50"
                      >
                        <ViewIcon />
                      </button>
                      {can('canManageInvites') && (
                        <button
                          onClick={() => setDeleteTargets([inv])}
                          title="Delete"
                          aria-label="Delete invitation"
                          className="rounded-md border border-red-200 p-1.5 text-red-700 hover:bg-red-50"
                        >
                          <DeleteIcon />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {expanded === inv.id && (
                  <tr className="bg-brand-ice-50/70">
                    <td colSpan={can('canManageInvites') ? 7 : 6} className="px-4 py-3 text-xs text-brand-navy-700/80">
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
              <tr><td colSpan={can('canManageInvites') ? 7 : 6} className="px-4 py-6 text-center text-brand-navy-700/50">No invitations found for this search.</td></tr>
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

      {deleteTargets && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-brand-navy-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-brand">
            <h3 className="text-lg font-semibold text-brand-navy-900">
              Delete {deleteTargets.length === 1 ? deleteTargets[0].serialNumber : `${deleteTargets.length} invitations`}?
            </h3>
            <p className="mt-2 text-sm text-brand-navy-700/80">
              This also permanently deletes the rendered card image{deleteTargets.length > 1 ? 's' : ''} from Cloud
              Storage — not just the record here. There is no undo.
            </p>
            {deleteTargets.length > 1 && (
              <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-brand-ice-200 bg-brand-ice-50 p-2 text-xs text-brand-navy-700">
                {deleteTargets.map((t) => (
                  <li key={t.id} className="font-mono">{t.serialNumber}</li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTargets(null)}
                disabled={deleting}
                className="rounded-lg border border-brand-ice-200 px-4 py-2 text-sm text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Deleting…' : 'Proceed — delete from website and Storage'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
