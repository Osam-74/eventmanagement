'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin, useSelectedEvent } from '@/lib/client/useAdmin';

type Usher = {
  id: string;
  name: string;
  gateId: string | null;
  active: boolean;
  acceptedCount: number;
  lastSeenAt: string | null;
  lastScanAt: string | null;
  lockedUntil: string | null;
  needsPinMigration?: boolean;
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export default function UshersPage() {
  const { can } = useAdmin();
  const { eventId } = useSelectedEvent();
  const [ushers, setUshers] = useState<Usher[]>([]);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [gateId, setGateId] = useState('');
  const [createdPin, setCreatedPin] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    if (!eventId) return;
    adminJson<{ ok: boolean; ushers: Usher[] }>(`/api/admin/ushers?eventId=${eventId}`)
      .then((r) => setUshers(r.ushers ?? []));
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreatedPin(null);
    const r = await adminJson<{ ok: boolean; pin?: string; message?: string }>('/api/admin/ushers', {
      method: 'POST',
      body: JSON.stringify({ eventId, name, ...(pin ? { pin } : {}), gateId: gateId || null }),
    }).catch(() => null);
    if (r?.ok) {
      setCreatedPin(r.pin ?? null);
      setName(''); setPin(''); setGateId('');
      load();
    } else {
      setMsg(r?.message ?? 'Could not create usher.');
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setMsg('');
    const r = await adminJson<{ ok: boolean; pin?: string | null; message?: string }>(`/api/admin/ushers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!r?.ok) {
      setMsg(r?.message ?? 'Update failed.');
      return;
    }
    if (r?.pin) setCreatedPin(r.pin);
    load();
  }

  if (!eventId) return <p className="text-brand-navy-700/60">Select an event first.</p>;

  const inputCls =
    'rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20';

  return (
    <div className="space-y-6">
      {can('canManageUshers') && (
        <form onSubmit={create} className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-semibold text-brand-navy-900">Create usher (gate official)</h2>
          <p className="mb-3 text-sm text-brand-navy-700/60">
            The PIN alone identifies the usher at the gate — no name or event selection there.
            Leave PIN empty for a secure auto-generated unique 6-digit PIN.
            The PIN is shown to you exactly once; hand it over privately.
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <input placeholder="Usher name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} required />
            <input placeholder="PIN (optional, 6 digits)" value={pin} onChange={(e) => setPin(e.target.value)} className={inputCls} />
            <input placeholder="Gate label (optional)" value={gateId} onChange={(e) => setGateId(e.target.value)} className={inputCls} />
            <button className="rounded-lg bg-brand-blue-500 px-4 py-2 font-medium text-white hover:bg-brand-blue-600">Create</button>
          </div>
          {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
          {createdPin && (
            <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm">
              PIN: <span className="font-mono text-lg font-bold">{createdPin}</span> — copy it now, it will not be shown again.
            </div>
          )}
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <h2 className="border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 font-semibold text-brand-navy-900">Ushers</h2>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-brand-ice-200 bg-brand-ice-50 text-left text-xs font-semibold uppercase tracking-wide text-brand-navy-700/50">
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Gate</th>
              <th className="px-4 py-2.5">Admitted</th>
              <th className="px-4 py-2.5">Last seen</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ushers.map((u) => (
              <tr key={u.id} className="border-t border-brand-ice-100 transition hover:bg-brand-ice-50/60">
                <td className="px-4 py-2.5 text-brand-navy-900">
                  {u.name}
                  {!u.active && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">disabled</span>}
                  {u.needsPinMigration && <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">PIN reset required</span>}
                  {u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now() && (
                    <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">locked until {fmt(u.lockedUntil)}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-brand-navy-700/60">{u.gateId ?? '—'}</td>
                <td className="px-4 py-2.5 font-medium text-brand-navy-900">{u.acceptedCount}</td>
                <td className="px-4 py-2.5 text-brand-navy-700/60">{fmt(u.lastSeenAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    <button onClick={() => patch(u.id, { active: !u.active })} className="rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50">
                      {u.active ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => { if (confirm('Reset PIN? You will get a new PIN shown once.')) patch(u.id, { resetPin: true }); }} className="rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50">
                      Reset PIN
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {ushers.length === 0 && <tr><td className="px-4 py-6 text-center text-brand-navy-700/50">No ushers yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
