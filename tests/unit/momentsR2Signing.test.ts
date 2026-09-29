import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Exercises the REAL presigner (no network): the URL must target the
 * account's R2 endpoint, carry a SigV4 signature and a bounded expiry, and
 * bind the Content-Type so a link for a photo can't be reused for a script.
 */
describe('R2 presigned URLs', () => {
  beforeAll(() => {
    process.env.R2_ACCOUNT_ID = 'acct123';
    process.env.R2_ACCESS_KEY_ID = 'AKIATESTKEY';
    process.env.R2_SECRET_ACCESS_KEY = 'secret-test-value';
    process.env.R2_BUCKET = 'event-moments';
  });

  it('reports which settings are missing', async () => {
    const r2 = await import('@/lib/moments/r2');
    const keep = process.env.R2_BUCKET;
    delete process.env.R2_BUCKET;
    expect(r2.r2Configured()).toBe(false);
    expect(r2.r2MissingEnv()).toEqual(['R2_BUCKET']);
    process.env.R2_BUCKET = keep;
    expect(r2.r2Configured()).toBe(true);
  });

  it('PUT link targets the R2 endpoint, is signed, expires in 1h and binds content-type', async () => {
    const r2 = await import('@/lib/moments/r2');
    const url = new URL(await r2.presignPut('events/e1/moments/abc.jpg', 'image/jpeg'));
    // virtual-hosted style: <bucket>.<account>.r2.cloudflarestorage.com (supported by R2)
    expect(url.hostname).toBe('event-moments.acct123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/events/e1/moments/abc.jpg');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBe(3600);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    // the secret is never in the URL
    expect(url.toString()).not.toContain('secret-test-value');
    // no checksum trailer params that R2 rejects
    expect(url.search).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum/i);
  });

  it('part links carry the upload id and part number', async () => {
    const r2 = await import('@/lib/moments/r2');
    const url = new URL(await r2.presignPart('events/e1/moments/v.mp4', 'UPLOAD-ID-1', 3));
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('UPLOAD-ID-1');
  });

  it('view links are short-lived (10 min) and downloads force a safe attachment filename', async () => {
    const r2 = await import('@/lib/moments/r2');
    const view = new URL(await r2.presignGet('events/e1/moments/abc.jpg'));
    expect(Number(view.searchParams.get('X-Amz-Expires'))).toBe(600);
    const dl = new URL(await r2.presignGet('events/e1/moments/abc.jpg', { download: 'a"b\r\n<x>.jpg' }));
    const disp = dl.searchParams.get('response-content-disposition') ?? '';
    expect(disp.startsWith('attachment; filename="')).toBe(true);
    expect(disp).not.toMatch(/[\r\n<>]/);
    expect(disp.slice('attachment; filename="'.length, -1)).not.toContain('"');
  });
});
