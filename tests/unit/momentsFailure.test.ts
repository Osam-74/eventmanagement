import { describe, it, expect, vi } from 'vitest';
import { momentsFailure } from '@/lib/api/helpers';

async function read(e: unknown) {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const res = momentsFailure('test', e);
  return { status: res.status, body: await res.json() };
}

describe('momentsFailure', () => {
  it('names a missing Firestore index instead of an empty 500', async () => {
    const r = await read(new Error('9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/...'));
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ ok: false, code: 'INDEX_MISSING' });
    expect(r.body.message).toContain('firestore:indexes');
  });
  it('names missing R2 settings', async () => {
    const r = await read(new Error('R2 is not configured: R2_BUCKET'));
    expect(r.body.code).toBe('STORAGE_NOT_CONFIGURED');
  });
  it('never leaks the raw internal error to the browser', async () => {
    const r = await read(new Error('secret internal path /srv/app/key.pem exploded'));
    expect(r.body.code).toBe('SERVER_ERROR');
    expect(JSON.stringify(r.body)).not.toContain('key.pem');
  });
});
