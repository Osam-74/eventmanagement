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
    const r = await adminJson<{ ok: boolean; pin?: string | null }>(`/api/admin/ushers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).catch(() => null);
    if (r?.pin) setCreatedPin(r.pin);
    load();
  }

  if (!eventId) return <p className="text-stone-500">Select an event first.</p>;

  return (
    <div className="space-y-6">
      {can('canManageUshers') && (
        <form onSubmit={create} className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-semibold">Create usher (gate official)</h2>
          <p className="mb-3 text-sm text-stone-500">
            Name + PIN only — no Firebase account. Leave PIN empty for a secure auto-generated 6-digit PIN.
            The PIN is shown to you exactly once; hand it over privately.
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <input placeholder="Usher name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" required />
            <input placeholder="PIN (optional, 6–10 digits)" value={pin} onChange={(e) => setPin(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" />
            <input placeholder="Gate label (optional)" value={gateId} onChange={(e) => setGateId(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" />
            <button className="rounded-lg bg-stone-900 px-4 py-2 text-white">Create</button>
          </div>
          {msg && <p className="mt-2 text-sm text-red-600">{msg}</p>}
          {createdPin && (
            <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm">
              PIN: <span className="font-mono text-lg font-bold">{createdPin}</span> — copy it now, it will not be shown again.
            </div>
          )}
        </form>
      )}

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-semibold">Ushers</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-stone-400">
              <th className="py-2">Name</th>
              <th className="py-2">Gate</th>
              <th className="py-2">Admitted</th>
              <th className="py-2">Last seen</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {ushers.map((u) => (
              <tr key={u.id} className="border-t border-stone-100">
                <td className="py-2">
                  {u.name}
                  {!u.active && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">disabled</span>}
                  {u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now() && (
                    <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700">locked until {fmt(u.lockedUntil)}</span>
                  )}
                </td>
                <td className="py-2 text-stone-500">{u.gateId ?? '—'}</td>
                <td className="py-2 font-medium">{u.acceptedCount}</td>
                <td className="py-2 text-stone-500">{fmt(u.lastSeenAt)}</td>
                <td className="py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => patch(u.id, { active: !u.active })} className="rounded border border-stone-300 px-2 py-1 text-xs">
                      {u.active ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => { if (confirm('Reset PIN? You will get a new PIN shown once.')) patch(u.id, { resetPin: true }); }} className="rounded border border-stone-300 px-2 py-1 text-xs">
                      Reset PIN
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {ushers.length === 0 && <tr><td className="py-3 text-stone-500">No ushers yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
