import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminFetch } from '@/lib/client/api';

let calls: Array<{ path: string; init: RequestInit }>;

beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof global.fetch;
});

describe('adminFetch content-type handling', () => {
  it('keeps application/json for plain (no-body / string-body) calls', async () => {
    await adminFetch('/api/admin/templates');
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' });

    await adminFetch('/api/admin/templates', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(calls[1].init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('attaches no Authorization header — the admin_session cookie is the authority', async () => {
    await adminFetch('/api/admin/ushers');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBeUndefined();
  });

  it('does NOT set Content-Type for FormData bodies so the browser can set the multipart boundary', async () => {
    const form = new FormData();
    form.append('name', 'Default template');
    form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'master.png', { type: 'image/png' }));

    await adminFetch('/api/admin/templates', { method: 'POST', body: form });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body).toBe(form);
  });

  it('still lets explicit caller headers win', async () => {
    const form = new FormData();
    await adminFetch('/api/admin/templates', { method: 'POST', body: form, headers: { 'X-Override': 'yes' } });
    expect(calls[0].init.headers).toEqual({ 'X-Override': 'yes' });
  });
});
