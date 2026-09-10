'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { adminJson } from '@/lib/client/api';

/**
 * One independent, progressively-loaded dashboard widget.
 *
 * - one fetch in flight at a time (a slow response can never stack
 *   overlapping requests — the cause of the aborted-fetch
 *   "NetworkError / Content-Length exceeds body" errors in production);
 * - optional polling ONLY while the tab is visible, with an immediate
 *   refresh when the tab becomes visible again;
 * - `error` + `retry` so one failed widget renders a retry card without
 *   touching any other widget.
 */
export function useAdminWidget<T>(url: string | null, opts?: { pollMs?: number }) {
  const pollMs = opts?.pollMs ?? 0;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (silent: boolean) => {
      if (!url || inFlight.current) return;
      inFlight.current = true;
      if (!silent) setLoading(true);
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        const r = await adminJson<T & { ok?: boolean; message?: string }>(url, { signal: abort.signal });
        if (!alive.current) return;
        if (r && r.ok === false) {
          setError(r.message || 'Could not load this panel.');
          setData(null);
        } else {
          setData(r);
          setError(null);
        }
      } catch {
        // Aborted on unmount (e.g. sign-out navigation) — not an error.
        if (alive.current && !abort.signal.aborted) {
          setError('Could not load this panel. Check your connection and retry.');
        }
      } finally {
        inFlight.current = false;
        if (alive.current) setLoading(false);
      }
    },
    [url]
  );

  useEffect(() => {
    alive.current = true;
    setData(null);
    setError(null);
    setLoading(url !== null);
    load(false);
    return () => {
      alive.current = false;
      // Abort in-flight widget requests on unmount: after sign-out the
      // session cookie is gone, and a late 401 from these requests would
      // hard-redirect the user to /login mid-logout.
      abortRef.current?.abort();
    };
  }, [load, url]);

  useEffect(() => {
    if (!pollMs || !url) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, pollMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') load(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollMs, url, load]);

  return { data, error, loading, retry: () => load(true) };
}
