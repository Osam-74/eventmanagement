'use client';

import { useEffect, useState } from 'react';
import { adminFetch, adminJson } from '@/lib/client/api';
import { useAdmin } from '@/lib/client/useAdmin';

type Template = {
  id: string;
  name: string;
  storagePath: string;
  canvasWidth: number;
  canvasHeight: number;
  qr: { x: number; y: number; size: number };
  serial: { enabled: boolean; x: number; y: number; fontSize: number };
  createdAt: string | null;
};

export default function TemplatesPage() {
  const { can } = useAdmin();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');

  const load = () => adminJson<{ ok: boolean; templates: Template[] }>('/api/admin/templates').then((r) => setTemplates(r.templates ?? []));
  useEffect(() => { load(); }, []);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { setMsg('Choose the QR-ready master artwork (PNG/JPG, no QR inside).'); return; }
    setMsg('Uploading…');
    const form = new FormData();
    form.append('name', name || 'Default template');
    form.append('file', file);
    const res = await adminFetch('/api/admin/templates', { method: 'POST', body: form });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { setMsg('Template saved.'); setName(''); setFile(null); load(); }
    else setMsg(body.message ?? 'Upload failed.');
  }

  async function remove(t: Template) {
    if (!window.confirm(`Delete template "${t.name}"? This cannot be undone.`)) return;
    setMsg('');
    const res = await adminFetch(`/api/admin/templates/${t.id}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { setMsg('Template deleted.'); load(); }
    else setMsg(body.message ?? 'Could not delete template.');
  }

  const inputCls =
    'rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2 text-sm text-brand-navy-900 outline-none focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20';

  return (
    <div className="space-y-6">
      {can('canManageEvents') && (
        <form onSubmit={upload} className="rounded-xl border border-brand-ice-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-semibold text-brand-navy-900">Upload QR-ready master artwork</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className={inputCls} />
            <button className="rounded-lg bg-brand-blue-500 px-4 py-2 font-medium text-white hover:bg-brand-blue-600">Upload template</button>
          </div>
          {msg && <p className="mt-2 text-sm text-brand-navy-700">{msg}</p>}
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-brand-ice-200 bg-white shadow-sm">
        <h2 className="border-b border-brand-ice-200 bg-brand-ice-50 px-4 py-3 font-semibold text-brand-navy-900">Templates</h2>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t border-brand-ice-100 transition hover:bg-brand-ice-50/60">
                <td className="px-4 py-2.5 font-medium text-brand-navy-900">{t.name}</td>
                <td className="px-4 py-2.5 text-brand-navy-700/60">{t.canvasWidth}×{t.canvasHeight}px</td>
                <td className="px-4 py-2.5 text-brand-navy-700/60">QR box {t.qr.x},{t.qr.y} size {t.qr.size}</td>
                <td className="px-4 py-2.5 text-brand-navy-700/60">serial {t.serial.enabled ? 'on' : 'off'}</td>
                <td className="px-4 py-2.5 text-right">
                  {can('canManageEvents') && (
                    <button onClick={() => remove(t)} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50">
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {templates.length === 0 && <tr><td className="px-4 py-6 text-center text-brand-navy-700/50">No templates yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
