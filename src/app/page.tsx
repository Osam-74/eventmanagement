'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';

export default function Home() {
  const router = useRouter();
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const unsub = onAuthStateChanged(getFirebaseAuth(), (user) => {
        if (user) {
          router.replace('/admin');
        } else {
          router.replace('/login');
        }
      });
      return unsub;
    } catch (e) {
      // Auth initialization failed (e.g. invalid/missing Firebase client config).
      // Show a clear message instead of an unhandled exception.
      setConfigError(e instanceof Error ? e.message : 'Firebase client failed to initialize');
    }
  }, [router]);

  if (configError) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm rounded-2xl bg-white p-8 text-center shadow-lg">
          <h1 className="mb-2 text-xl font-semibold">Configuration error</h1>
          <p className="text-sm text-stone-500">
            The app could not initialize Firebase: {configError}
          </p>
          <p className="mt-2 text-xs text-stone-400">
            Contact the administrator with this message.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-stone-500">Loading…</p>
    </main>
  );
}
