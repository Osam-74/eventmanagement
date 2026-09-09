'use client';

import { getFirebaseAuth } from '@/lib/firebase/client';

export async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  const user = getFirebaseAuth().currentUser;
  const token = user ? await user.getIdToken() : null;
  // Let the browser set the multipart boundary itself when uploading files —
  // forcing application/json on a FormData body breaks req.formData().
  const isFormBody = typeof FormData !== 'undefined' && init?.body instanceof FormData;
  return fetch(path, {
    ...init,
    headers: {
      ...(isFormBody ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
