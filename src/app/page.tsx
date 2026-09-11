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

// Simple monoline icons, inline so no new dependency — kept visually
// consistent with the rest of the brand's restrained, single-weight style.
function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M12 3l7 3v5c0 5-3.2 8.5-7 10-3.8-1.5-7-5-7-10V6l7-3Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScanIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2M20 8V6a2 2 0 0 0-2-2h-2M20 16v2a2 2 0 0 1-2 2h-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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
    <main className="flex min-h-screen items-center justify-center bg-brand-blush px-4 py-10">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-2xl bg-white shadow-brand ring-1 ring-brand-ice-200">
          <Image src="/brand/mark.png" alt="Event Access" width={48} height={48} priority />
        </div>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight text-brand-navy-900">Event Access Control</h1>
        <p className="mb-9 text-sm text-brand-navy-700/60">Choose how you&apos;d like to continue</p>

        <div className="space-y-3.5">
          {/* Accessible name is pinned via aria-label so it reads as exactly
              "Admin"/"Usher" regardless of the supporting copy inside — both
              the current wording and any future tweak to it. */}
          <Link
            href="/login"
            aria-label="Admin"
            className="group flex items-center gap-4 rounded-2xl border border-brand-ice-200 bg-white px-5 py-4 text-left shadow-sm transition hover:border-brand-blue-400/60 hover:shadow-brand active:scale-[0.98]"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-ice-50 text-brand-blue-500">
              <ShieldIcon className="h-6 w-6" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold text-brand-navy-900">Admin</span>
              <span className="block text-xs text-brand-navy-700/55">Manage invitations, ushers and event access</span>
            </span>
            <ChevronIcon className="h-5 w-5 shrink-0 text-brand-navy-700/30 transition group-hover:text-brand-blue-500" />
          </Link>

          <Link
            href="/usher/login"
            aria-label="Usher"
            className="group flex items-center gap-4 rounded-2xl bg-brand-navy-900 px-5 py-4 text-left shadow-brand transition hover:bg-brand-navy-800 active:scale-[0.98]"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/10 text-brand-teal-400">
              <ScanIcon className="h-6 w-6" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-semibold text-white">Usher</span>
              <span className="block text-xs text-brand-ice-200/60">Scan invitations and admit guests</span>
            </span>
            <ChevronIcon className="h-5 w-5 shrink-0 text-white/40 transition group-hover:text-brand-teal-400" />
          </Link>
        </div>

        <InstallPrompt />
      </div>
    </main>
  );
}
