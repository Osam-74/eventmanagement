'use client';

import { useEffect, useState } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';
import { adminJson } from '@/lib/client/api';

export type AdminProfile = {
  uid: string;
  email: string;
  displayName: string;
  accountType: 'ROOT_ADMIN' | 'ADMIN';
  permissions: Record<string, boolean>;
} | null;

export function useAdmin() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<AdminProfile>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(getFirebaseAuth(), async (u) => {
      setUser(u);
      if (u) {
        const res = await adminJson<{ ok: boolean; admin: AdminProfile }>('/api/me').catch(() => null);
        setProfile(res?.admin ?? null);
        if (res && !res.admin) window.location.href = '/login';
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const can = (p: string) =>
    profile?.accountType === 'ROOT_ADMIN' || Boolean(profile?.permissions?.[p]);

  return { user, profile, loading, can };
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
