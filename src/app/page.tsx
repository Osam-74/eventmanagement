'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
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
    <main className="flex min-h-screen items-center justify-center bg-brand-blush px-4">
      <div className="w-full max-w-sm text-center">
        <Image src="/brand/mark.png" alt="Event Access" width={56} height={56} className="mx-auto mb-5" priority />
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-brand-navy-900">Event Access Control</h1>
        <p className="mb-10 text-sm text-brand-navy-700/60">Please select your user type to login.</p>

        <div className="space-y-4">
          <Link
            href="/login"
            className="block rounded-2xl border border-brand-ice-200 bg-white px-6 py-8 text-xl font-semibold text-brand-navy-900 shadow-brand transition hover:border-brand-blue-400 hover:shadow-lg"
          >
            ADMIN
          </Link>
          <Link
            href="/usher/login"
            className="block rounded-2xl bg-brand-navy-900 px-6 py-8 text-xl font-semibold text-white shadow-brand transition hover:bg-brand-navy-800"
          >
            USHER
          </Link>
        </div>

        <InstallPrompt />
      </div>
    </main>
  );
}
