'use client';

import { useCallback, useEffect, useState } from 'react';
import { sendPasswordResetEmail } from 'firebase/auth';
import { adminJson } from '@/lib/client/api';
import { getFirebaseAuth } from '@/lib/firebase/client';
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
  const [resetUid, setResetUid] = useState<string | null>(null); // which admin's reset is in flight
  const [resetSentUid, setResetSentUid] = useState<string | null>(null); // last one that succeeded

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

  /**
   * Send THAT admin a Firebase password-reset email (owner request,
   * 2026-09-11) — this is the exact same public Firebase Auth operation
   * the "Reset password" link on the login page already uses (just with
   * a different target email), so it needs no backend endpoint: it
   * doesn't touch or need to know the caller's own session at all. A
   * continueUrl is set so Firebase's own reset-password page offers a
   * link straight back to our login page once the admin sets a new
   * password. (The wording/branding of the EMAIL ITSELF — subject, sender
   * name, logo — is a Firebase Console setting under Authentication →
   * Templates → Password reset, not something changeable from app code.)
   */
  async function sendReset(a: AdminItem) {
    setResetUid(a.uid);
    setResetSentUid(null);
    setMsg('');
    try {
      await sendPasswordResetEmail(getFirebaseAuth(), a.email, { url: `${window.location.origin}/login` });
      setResetSentUid(a.uid);
      setMsg(`Password reset email sent to ${a.email}.`);
    } catch {
      setMsg(`Could not send a reset email to ${a.email}. Check the address and try again.`);
    } finally {
      setResetUid(null);
    }
  }

  const inputCls =
    'rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20';

  // Shared bits so the desktop table and the mobile card layout (below)
  // render identical permission controls and actions without duplicating
  // the logic that decides what's editable vs read-only.
  function PermissionControls({ a }: { a: AdminItem; dense?: boolean }) {
    return (
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
    );
  }

  function Actions({ a }: { a: AdminItem }) {
    // Any admin who can manage admins can send a reset to anyone, including
    // the Root Admin (it's just an email to an address the recipient
    // controls — it can't be used to escalate or lock anyone out).
    return (
      <>
        {can('canManageAdmins') && (
          <button
            onClick={() => sendReset(a)}
            disabled={resetUid === a.uid}
            className="rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-50"
          >
            {resetUid === a.uid ? 'Sending…' : resetSentUid === a.uid ? 'Sent ✓' : 'Send reset'}
          </button>
        )}
        {a.accountType !== 'ROOT_ADMIN' && can('canManageAdmins') && (
          <button onClick={() => patch(a.uid, { active: !a.active })} className="ml-2 rounded-md border border-brand-ice-200 px-2 py-1 text-xs text-brand-navy-700 hover:bg-brand-ice-50">
            {a.active ? 'Disable' : 'Enable'}
          </button>
        )}
        {a.accountType !== 'ROOT_ADMIN' && can('canManageAdmins') && a.uid !== profile?.uid && (
          <button onClick={() => remove(a)} className="ml-2 rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
            Delete
          </button>
        )}
        {a.uid === profile?.uid && <span className="ml-2 text-xs text-brand-navy-700/40">(you)</span>}
      </>
    );
  }

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

        {/* Desktop/tablet: real table (≥md). Permission checkboxes for a
            non-root admin can run to 6 items — a horizontal-scroll table on
            a phone made those genuinely hard to use (owner-reported,
            2026-09-10), so mobile gets its own stacked-card layout below
            instead of relying on scroll. */}
        <div className="hidden overflow-x-auto md:block">
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
                  <td className="px-4 py-2.5"><PermissionControls a={a} /></td>
                  <td className="px-4 py-2.5 text-right"><Actions a={a} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: one full-width card per admin, nothing clipped or
            scrolled — every permission checkbox and action is directly
            tappable without horizontal scrolling. */}
        <div className="divide-y divide-brand-ice-100 md:hidden">
          {admins.map((a) => (
            <div key={a.uid} className="p-4">
              <p className="font-medium text-brand-navy-900">
                {a.displayName}
                {a.accountType === 'ROOT_ADMIN' && (
                  <span className="ml-2 rounded bg-brand-navy-900 px-2 py-0.5 text-xs text-white">ROOT</span>
                )}
              </p>
              <p className="text-sm text-brand-navy-700/60">{a.email}</p>
              {!a.active && <p className="text-sm text-red-600">disabled</p>}
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-brand-navy-700/40">Permissions</p>
              <div className="mt-1.5"><PermissionControls a={a} /></div>
              <div className="mt-3 flex items-center"><Actions a={a} /></div>
            </div>
          ))}
        </div>

        {admins.length === 0 && <p className="p-4 text-sm text-brand-navy-700/60">No administrators yet.</p>}
      </div>
    </div>
  );
}
