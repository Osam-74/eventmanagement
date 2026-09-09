'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { onAuthStateChanged } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const unsub = onAuthStateChanged(getFirebaseAuth(), (user) => {
      if (user) {
        router.replace('/admin');
      } else {
        router.replace('/login');
      }
    });
    return unsub;
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-stone-500">Loading…</p>
    </main>
  );
}
