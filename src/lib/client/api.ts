'use client';

/**
 * Admin API fetch. Authentication is the server-established admin_session
 * HttpOnly cookie — set by /api/auth/session POST after full validation and
 * re-confirmed against users/{uid} on EVERY request server-side. The
 * client deliberately does NOT attach a Firebase ID token any more: the
 * cookie carries equivalent authority, and the removed getIdToken() call
 * put a Firebase Auth network round-trip (with its own failure mode) in
 * front of every API request. (The server still accepts Bearer tokens for
 * tooling and tests.)
 */
export async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  // Let the browser set the multipart boundary itself when uploading files —
  // forcing application/json on a FormData body breaks req.formData().
  const isFormBody = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  return fetch(path, {
    ...init,
    headers: {
      ...(isFormBody ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {}),
    },
  });
}

export async function adminJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await adminFetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status === 401) {
    window.location.href = '/login';
  }
  return body as T;
}
