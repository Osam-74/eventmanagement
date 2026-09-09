'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { onAuthStateChanged } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';
import InstallPrompt from '@/components/InstallPrompt';

/**
 * Unified entry point. Everyone starts here and picks a role.
 * Smart routing: an usher with a still-valid server session goes straight
 * to /scan; a signed-in admin goes to /admin. Session validity is decided
 * by the server (/api/usher/session re-validates the cookie, usher active
 * state and expiry; /admin re-checks admin auth) — this shortcut never
 * weakens session expiration or revocation.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let settled = false;
    // Usher session shortcut (server-authoritative).
    fetch('/api/usher/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!settled && b?.session) {
          settled = true;
          router.replace('/scan');
        }
      })
      .catch(() => undefined);
    // Admin session shortcut (Firebase Auth client state).
    try {
      const unsub = onAuthStateChanged(getFirebaseAuth(), (user) => {
        if (!settled && user) {
          settled = true;
          router.replace('/admin');
        }
      });
      return unsub;
    } catch {
      return undefined;
    }
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Welcome to I &amp; S Access</h1>
        <p className="mb-10 text-sm text-stone-500">Wedding invitation access control</p>

        <div className="space-y-4">
          <Link
            href="/login"
            className="block rounded-2xl border border-stone-300 bg-white px-6 py-8 text-xl font-semibold text-stone-900 shadow-lg transition hover:border-stone-500"
          >
            ADMIN
            <span className="mt-1 block text-xs font-normal text-stone-500">Event management &amp; dashboard</span>
          </Link>
          <Link
            href="/usher/login"
            className="block rounded-2xl bg-stone-900 px-6 py-8 text-xl font-semibold text-white shadow-lg transition hover:bg-stone-800"
          >
            USHER
            <span className="mt-1 block text-xs font-normal text-stone-400">Gate QR scanning</span>
          </Link>
        </div>

        <InstallPrompt />
      </div>
    </main>
  );
}
