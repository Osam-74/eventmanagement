'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminJson } from '@/lib/client/api';

export type AdminProfile = {
  uid: string;
  email: string;
  displayName: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  permissions: Record<string, boolean>;
} | null;

/**
 * Admin UI auth state — derived ONLY from the server-established session
 * (HttpOnly admin_session cookie, validated by /api/auth/session against
 * the users/{uid} record). The Firebase client auth state is deliberately
 * NOT consulted here: it was the source of the production login/logout
 * ping-pong (two independent auth states that could disagree). One
 * authority: the server session.
 */
export function useAdmin() {
  const router = useRouter();
  const [profile, setProfile] = useState<AdminProfile>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    adminJson<{ ok: boolean; admin: AdminProfile }>('/api/auth/session')
      .then((r) => {
        if (cancelled) return;
        setProfile(r.admin ?? null);
        if (!r.admin) router.replace('/login');
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const can = (p: string) =>
    profile?.accountType === 'ROOT_ADMIN' || Boolean(profile?.permissions?.[p]);

  return { profile, loading, can };
}

export function useSelectedEvent() {
  const [eventId, setEventId] = useState<string>('');
  useEffect(() => {
    const saved = localStorage.getItem('selectedEventId');
    if (saved) setEventId(saved);
  }, []);
  const select = (id: string) => {
    localStorage.setItem('selectedEventId', id);
    setEventId(id);
  };
  return { eventId, select };
}
