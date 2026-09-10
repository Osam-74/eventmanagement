'use client';

import { createContext, useContext } from 'react';
import { adminJson } from '@/lib/client/api';

export type AdminProfile = {
  uid: string;
  email: string;
  displayName: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  permissions: Record<string, boolean>;
} | null;

/**
 * Explicit authorization state. 'loading' means the ROOT_ADMIN/admin record
 * is STILL being resolved — the UI must show a neutral loading state and can
 * never render permission-denied messages (no "You lack …" flash).
 */
export type AdminAuthzStatus = 'loading' | 'authorized' | 'unauthorized';

// ---------------------------------------------------------------------------
// Shared session source (module-level).
//
// Previously EVERY admin page called its own useAdmin(), each firing a
// separate /api/auth/session request: the layout + the active page meant 2+
// requests per navigation, and a page that mounted with profile=null
// rendered "You lack permission" until ITS OWN slower fetch resolved — the
// false-permission flash seen in production.
//
// Now the session is fetched exactly once per page load (simultaneous
// consumers share one in-flight promise; the successful result is cached
// for the lifetime of the page session). Pages read it via context from
// the layout, which already gates children until the session resolves.
// ---------------------------------------------------------------------------

let sessionCache: AdminProfile | undefined;
let sessionInFlight: Promise<AdminProfile> | null = null;

/**
 * Resolve the admin session from the server (authoritative). Simultaneous
 * callers share one request. Network errors REJECT (nothing is cached — the
 * caller can retry); a resolved `{ admin: null }` IS cached as unauthorized.
 */
export function fetchAdminSession(): Promise<AdminProfile> {
  if (sessionCache !== undefined) return Promise.resolve(sessionCache);
  if (sessionInFlight) return sessionInFlight;
  sessionInFlight = adminJson<{ ok: boolean; admin: AdminProfile }>('/api/auth/session')
    .then((r) => {
      // Cache ONLY a confirmed-authorized session. Never cache `null`:
      // the /login flow and the layout's gate redirect run in the SAME
      // client document — a cached "unauthorized" would make the NEXT
      // login bounce straight back to /login until a full page reload.
      if (r.admin) sessionCache = r.admin;
      return r.admin ?? null;
    })
    .finally(() => {
      sessionInFlight = null;
    });
  return sessionInFlight;
}

/** Called on logout (and before redirecting to /login) — never stale. */
export function clearAdminSessionCache() {
  sessionCache = undefined;
  sessionInFlight = null;
}

// ---------------------------------------------------------------------------
// Contexts — provided by the admin layout, consumed by pages.
// ---------------------------------------------------------------------------

type AdminSessionContextValue = {
  status: AdminAuthzStatus;
  profile: AdminProfile;
  can: (permission: string) => boolean;
};

const AdminSessionContext = createContext<AdminSessionContextValue>({
  status: 'loading',
  profile: null,
  can: () => false,
});

export const AdminSessionProvider = AdminSessionContext.Provider;

type SelectedEventContextValue = {
  eventId: string;
  select: (id: string) => void;
};

const SelectedEventContext = createContext<SelectedEventContextValue>({
  eventId: '',
  select: () => undefined,
});

export const SelectedEventProvider = SelectedEventContext.Provider;

/**
 * Admin auth state + permissions for the current page. Backed by the shared
 * session (context), so mounting a page NEVER refires /api/auth/session and
 * permissions are correct from the first render (no flash).
 *
 * `can(p)` is only meaningful when status === 'authorized'. The layout
 * gate guarantees pages only render once authorized.
 */
export function useAdmin() {
  const { status, profile, can } = useContext(AdminSessionContext);
  return { profile, loading: status === 'loading', status, can };
}

/**
 * Currently selected event id. Backed by context from the layout, so the id
 * propagates to already-mounted pages the moment the layout resolves it
 * (the localStorage-only version never did — the dashboard never loaded on
 * a fresh login). Persisted to localStorage for across-reload continuity.
 */
export function useSelectedEvent() {
  return useContext(SelectedEventContext);
}
