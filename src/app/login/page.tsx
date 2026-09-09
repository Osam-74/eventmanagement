'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
      router.replace('/admin');
    } catch {
      setError('Invalid email or password.');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!email) {
      setError('Enter your email first, then tap Reset.');
      return;
    }
    try {
      await sendPasswordResetEmail(getFirebaseAuth(), email);
      setResetSent(true);
      setError('');
    } catch {
      setError('Could not send reset email.');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="mb-1 text-2xl font-semibold">Event Access Control</h1>
        <p className="mb-6 text-sm text-stone-500">Administrator sign-in</p>

        <label className="block text-sm font-medium text-stone-700">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
          required
        />

        <label className="block text-sm font-medium text-stone-700">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
          required
        />

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
        {resetSent && <p className="mb-4 text-sm text-emerald-600">Reset email sent. Check your inbox.</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-stone-900 py-2.5 font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <button type="button" onClick={resetPassword} className="mt-4 w-full text-center text-sm text-stone-500 underline">
          Forgot password?
        </button>
      </form>
    </main>
  );
}
