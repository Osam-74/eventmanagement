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

  return (
    <div className="space-y-6">
      {can('canManageAdmins') && (
        <form onSubmit={create} className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-semibold">Create administrator</h2>
          <p className="mb-3 text-sm text-stone-500">
            New administrators start with only the capabilities you tick. You cannot grant a capability you do not
            have yourself.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" required />
            <input placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" required />
            <input type="password" placeholder="Password (min 10 chars)" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" required minLength={10} />
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            {PERMS.map((p) => (
              <label key={p} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={Boolean(perms[p])}
                  disabled={p === 'canManageAdmins' && !can('canManageAdmins')}
                  onChange={(e) => setPerms({ ...perms, [p]: e.target.checked })}
                />
                {p}
              </label>
            ))}
          </div>
          {msg && <p className="mt-2 text-sm text-stone-700">{msg}</p>}
          <button className="mt-3 rounded-lg bg-stone-900 px-4 py-2 text-white">Create</button>
        </form>
      )}

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-semibold">Administrators</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-stone-400">
              <th className="py-2">Name</th>
              <th className="py-2">Permissions</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.uid} className="border-t border-stone-100 align-top">
                <td className="py-2">
                  <p className="font-medium">
                    {a.displayName}
                    {a.accountType === 'ROOT_ADMIN' && (
                      <span className="ml-2 rounded bg-stone-900 px-2 py-0.5 text-xs text-white">ROOT</span>
                    )}
                  </p>
                  <p className="text-stone-500">{a.email}</p>
                  {!a.active && <p className="text-red-600">disabled</p>}
                </td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-2">
                    {a.accountType !== 'ROOT_ADMIN' && can('canManageAdmins')
                      ? PERMS.map((p) => (
                          <label key={p} className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={Boolean(a.permissions?.[p])}
                              disabled={p === 'canManageAdmins' && !can('canManageAdmins') && !a.permissions?.[p]}
                              onChange={(e) => patch(a.uid, { permissions: { [p]: e.target.checked } })}
                            />
                            {p.replace('can', '').replace('Manage', '')}
                          </label>
                        ))
                      : PERMS.filter((p) => a.permissions?.[p]).map((p) => (
                          <span key={p} className="rounded bg-stone-100 px-2 py-0.5 text-xs">{p}</span>
                        ))}
                  </div>
                </td>
                <td className="py-2 text-right">
                  {a.accountType !== 'ROOT_ADMIN' && can('canManageAdmins') && (
                    <button onClick={() => patch(a.uid, { active: !a.active })} className="rounded border border-stone-300 px-2 py-1 text-xs">
                      {a.active ? 'Disable' : 'Enable'}
                    </button>
                  )}
                  {a.uid === profile?.uid && <span className="ml-2 text-xs text-stone-400">(you)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
