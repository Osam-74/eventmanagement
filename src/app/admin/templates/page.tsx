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

  return (
    <div className="space-y-6">
      {can('canManageEvents') && (
        <form onSubmit={upload} className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-1 font-semibold">Upload QR-ready master artwork</h2>
          <p className="mb-3 text-sm text-stone-500">
            The master must contain the approved design and the gold “Access code” frame, but <strong>no QR</strong> —
            the system overlays the real QR at the approved coordinates (normalized 0.3907 / 0.6633 / 0.2206).
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <input placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-stone-300 px-3 py-2" />
            <input type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="rounded-lg border border-stone-300 px-3 py-2" />
            <button className="rounded-lg bg-stone-900 px-4 py-2 text-white">Upload template</button>
          </div>
          {msg && <p className="mt-2 text-sm text-stone-600">{msg}</p>}
        </form>
      )}

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <h2 className="mb-3 font-semibold">Templates</h2>
        <table className="w-full text-sm">
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-t border-stone-100">
                <td className="py-2 font-medium">{t.name}</td>
                <td className="py-2 text-stone-500">{t.canvasWidth}×{t.canvasHeight}px</td>
                <td className="py-2 text-stone-500">QR box {t.qr.x},{t.qr.y} size {t.qr.size}</td>
                <td className="py-2 text-stone-500">serial {t.serial.enabled ? 'on' : 'off'}</td>
              </tr>
            ))}
            {templates.length === 0 && <tr><td className="text-stone-500">No templates yet.</td></tr>}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-stone-400">
          To assign a template to an event, use the API <code>PATCH /api/admin/events/&#123;id&#125;</code> with templateId, or contact the developer console. (Assignment UI coming with template preview.)
        </p>
      </div>
    </div>
  );
}
