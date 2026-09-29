/**
 * Browser-side uploader for guest moments. Pure logic + fetch/XHR, no React,
 * so the retry / multipart behaviour is unit-testable.
 *
 * Flow per file: ask the server to sign -> PUT straight to Cloudflare R2
 * (single, or 8 MiB parts for big videos) -> tell the server it is done.
 * Uploads run a few at a time so a phone on weak signal isn't overwhelmed,
 * and every network step retries with back-off before giving up.
 */

export type StartedSingle = { ok: true; momentId: string; name: string; mode: 'single'; url: string; contentType: string };
export type StartedMultipart = {
  ok: true; momentId: string; name: string; mode: 'multipart'; contentType: string; partSize: number;
  parts: { partNumber: number; url: string }[];
};
export type StartedFail = { ok: false; name: string; message: string };
export type Started = StartedSingle | StartedMultipart | StartedFail;

export const CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries `fn` with exponential back-off (0.8s, 1.6s, 3.2s). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = MAX_ATTEMPTS, baseMs = 800): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if ((e as { fatal?: boolean }).fatal) throw e; // e.g. 4xx: retrying can't help
      if (i < attempts - 1) await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

/** PUT a Blob to a presigned URL with progress; resolves with the ETag header. */
export function putBlob(url: string, blob: Blob, contentType: string | null, onProgress: (loaded: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.getResponseHeader('ETag'));
      const err = new Error(`Upload failed (${xhr.status})`) as Error & { fatal?: boolean };
      err.fatal = xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429;
      reject(err);
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.ontimeout = () => reject(new Error('Timed out'));
    xhr.send(blob);
  });
}

export type UploadOutcome =
  | { ok: true; momentId: string; kind: 'photo' | 'video'; previewUrl: string }
  | { ok: false; message: string };

/** Uploads ONE already-signed file end to end and confirms it with the server. */
export async function uploadOne(
  slug: string,
  guestId: string,
  file: File,
  started: StartedSingle | StartedMultipart,
  onProgress: (fraction: number) => void
): Promise<UploadOutcome> {
  try {
    let parts: { PartNumber: number; ETag: string }[] | undefined;
    if (started.mode === 'single') {
      await withRetry(() => putBlob(started.url, file, started.contentType, (l) => onProgress(l / file.size)));
    } else {
      parts = [];
      const done = new Array(started.parts.length).fill(0) as number[];
      const report = () => onProgress(done.reduce((a, b) => a + b, 0) / file.size);
      for (const p of started.parts) {
        const start = (p.partNumber - 1) * started.partSize;
        const blob = file.slice(start, Math.min(start + started.partSize, file.size));
        const etag = await withRetry(() => putBlob(p.url, blob, null, (l) => { done[p.partNumber - 1] = l; report(); }));
        if (!etag) throw new Error('Missing ETag: check the R2 bucket CORS ExposeHeaders includes ETag');
        done[p.partNumber - 1] = blob.size;
        report();
        parts.push({ PartNumber: p.partNumber, ETag: etag });
      }
    }
    const res = await withRetry(async () => {
      const r = await fetch(`/api/moments/${encodeURIComponent(slug)}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId, momentId: started.momentId, parts }),
      });
      const body = (await r.json().catch(() => null)) as
        | { ok: true; momentId: string; kind: 'photo' | 'video'; previewUrl: string }
        | { ok: false; message: string }
        | null;
      if (!body) throw new Error('Bad response');
      if (!body.ok && r.status >= 400 && r.status < 500) { const e = new Error(body.message) as Error & { fatal?: boolean }; e.fatal = true; throw e; }
      if (!body.ok) throw new Error(body.message);
      return body;
    });
    onProgress(1);
    return res;
  } catch (e) {
    fetch(`/api/moments/${encodeURIComponent(slug)}/abort`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, momentId: started.momentId }),
    }).catch(() => undefined);
    return { ok: false, message: (e as Error).message || 'Upload failed' };
  }
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
export async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** A stable anonymous id for this browser, so the per-guest cap works without sign-in. */
export function getGuestId(): string {
  const KEY = 'moments_guest_id';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // Private mode etc: a per-page-load id still works, the cap is just per session.
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}
