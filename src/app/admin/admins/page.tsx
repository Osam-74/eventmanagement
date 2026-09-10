'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminJson } from '@/lib/client/api';
import { useAdmin } from '@/lib/client/useAdmin';

type AdminItem = {
  uid: string;
  email: string;
  displayName: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  active: boolean;
  permissions: Record<string, boolean>;
};

const PERMS = [
  'canManageAdmins',
  'canManageEvents',
  'canGenerateInvites',
  'canManageInvites',
  'canManageUshers',
  'canViewAnalytics',
] as const;

export default function AdminsPage() {
  const { can, profile } = useAdmin();
  const [admins, setAdmins] = useState<AdminItem[]>([]);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [perms, setPerms] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    adminJson<{ ok: boolean; admins: AdminItem[] }>('/api/admin/admins').then((r) => setAdmins(r.admins ?? []));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const r = await adminJson<{ ok: boolean; message?: string }>('/api/admin/admins', {
      method: 'POST',
      body: JSON.stringify({ email, password, displayName, permissions: perms }),
    }).catch(() => null);
    if (r?.ok) {
      setEmail(''); setDisplayName(''); setPassword(''); setPerms({});
      setMsg('Administrator created.');
      load();
    } else {
      setMsg(r?.message ?? 'Could not create administrator.');
    }
  }

  async function patch(uid: string, body: Record<string, unknown>) {
    await adminJson(`/api/admin/admins/${uid}`, { method: 'PATCH', body: JSON.stringify(body) });
    load();
  }

  async function remove(a: AdminItem) {
    if (!window.confirm(`Permanently delete ${a.displayName} (${a.email})? This removes their account entirely — they will no longer be able to sign in. This cannot be undone.`)) return;
    const r = await adminJson<{ ok: boolean; message?: string }>(`/api/admin/admins/${a.uid}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) { setMsg(r?.message ?? 'Could not delete administrator.'); return; }
    load();
  }

  const inputCls =
    'rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20';

  return (
    <div className="space-y-6">
      {can('canManageAdmins') && (
        <form onSubmit={create} className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-semibold text-brand-navy-900">Create administrator</h2>
          <p className="mb-3 text-sm text-brand-navy-700/60">
            New administrators start with only the capabilities you tick. You cannot grant a capability you do not
            have yourself.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} required />
            <input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} required />
            <input type="password" placeholder="Password (min 10 chars)" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} required minLength={10} />
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-sm text-brand-navy-800">
            {PERMS.map((p) => (
              <label key={p} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={Boolean(perms[p])}
                  disabled={p === 'canManageAdmins' && !can('canManageAdmins')}
                  onChange={(e) => setPerms({ ...perms, [p]: e.target.checked })}
                  className="accent-brand-blue-500"
                />
                {p}
              </label>
            ))}
          </div>
          {msg && <p className="mt-2 text-sm text-brand-navy-700">{msg}</p>}
          <button className="mt-3 rounded-lg bg-brand-blue-500 px-4 py-2 font-medium text-white hover:bg-brand-blue-600">Create</button>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <h2 className="border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 font-semibold text-brand-navy-900">Administrators</h2>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b border-brand-ice-200 bg-brand-ice-50 text-left text-xs font-semibold uppercase tracking-wide text-brand-navy-700/50">
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Permissions</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.uid} className="border-t border-brand-ice-100 align-top transition hover:bg-brand-ice-50/60">
                <td className="px-4 py-2.5">
                  <p className="font-medium text-brand-navy-900">
                    {a.displayName}
                    {a.accountType === 'ROOT_ADMIN' && (
                      <span className="ml-2 rounded bg-brand-navy-900 px-2 py-0.5 text-xs text-white">ROOT</span>
                    )}
                  </p>
                  <p className="text-brand-navy-700/60">{a.email}</p>
                  {!a.active && <p className="text-red-600">disabled</p>}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-2">
                    {a.accountType !== 'ROOT_ADMIN' && can('canManageAdmins')
                      ? PERMS.map((p) => (
                          <label key={p} className="flex items-center gap-1 text-xs text-brand-navy-800">
                            <input
                              type="checkbox"
                              checked={Boolean(a.permissions?.[p])}
                              disabled={p === 'canManageAdmins' && !can('canManageAdmins') && !a.permissions?.[p]}
                              onChange={(e) => patch(a.uid, { permissions: { [p]: e.target.checked } })}
                              className="accent-brand-blue-500"
                            />
                            {p.replace('can', '').replace('Manage', '')}
                          </label>
                        ))
                      : PERMS.filter((p) => a.permissions?.[p]).map((p) => (
                          <span key={p} className="rounded bg-brand-ice-100 px-2 py-0.5 text-xs text-brand-navy-700">{p}</span>
                        ))}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {a.accountType !== 'ROOT_ADMIN' && can('canManageAdmins') && (
                    <button onClick={() => patch(a.uid, { active: !a.active })} className="rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50">
                      {a.active ? 'Disable' : 'Enable'}
                    </button>
                  )}
                  {a.accountType !== 'ROOT_ADMIN' && can('canManageAdmins') && a.uid !== profile?.uid && (
                    <button onClick={() => remove(a)} className="ml-2 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                      Delete
                    </button>
                  )}
                  {a.uid === profile?.uid && <span className="ml-2 text-xs text-brand-navy-700/40">(you)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
