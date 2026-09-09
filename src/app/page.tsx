'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import InstallPrompt from '@/components/InstallPrompt';

/**
 * Unified entry point. Everyone starts here and picks a user type.
 * Smart routing is fully server-authoritative: an usher with a valid
 * session (re-validated by /api/usher/session) goes to /scan; an admin
 * with a server-established session (validated by /api/auth/session)
 * goes to /admin. No client-side auth state drives either decision.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let settled = false;
    fetch('/api/usher/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!settled && b?.session) {
          settled = true;
          router.replace('/scan');
        }
      })
      .catch(() => undefined);
    fetch('/api/auth/session')
      .then((r) => r.json().catch(() => null))
      .then((b) => {
        if (!settled && b?.admin) {
          settled = true;
          router.replace('/admin');
        }
      })
      .catch(() => undefined);
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Event Access Control</h1>
        <p className="mb-10 text-sm text-stone-500">Please select your user type to login.</p>

        <div className="space-y-4">
          <Link
            href="/login"
            className="block rounded-2xl border border-stone-300 bg-white px-6 py-8 text-xl font-semibold text-stone-900 shadow-lg transition hover:border-stone-500"
          >
            ADMIN
          </Link>
          <Link
            href="/usher/login"
            className="block rounded-2xl bg-stone-900 px-6 py-8 text-xl font-semibold text-white shadow-lg transition hover:bg-stone-800"
          >
            USHER
          </Link>
        </div>

        <InstallPrompt />
      </div>
    </main>
  );
}
