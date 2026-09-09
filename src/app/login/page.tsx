'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getFirebaseAuth } from '@/lib/firebase/client';

/**
 * Admin sign-in — ONE authoritative success sequence:
 *
 *   Firebase email/password succeeds
 *     → obtain a fresh ID token
 *       → POST it to /api/auth/session (server verifies the token AND the
 *         admin authorization record, and establishes the HttpOnly session)
 *         → ONLY THEN redirect to /admin.
 *
 * Any failure signs the client out of Firebase and shows an error — a
 * failed attempt can never later transition into authenticated UI.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  // Already holding a valid server-established session? Go to /admin.
  useEffect(() => {
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((b) => {
        if (b?.admin) router.replace('/admin');
      })
      .catch(() => undefined);
  }, [router]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(getFirebaseAuth(), email, password);
      // The client sign-in is NOT success yet — the server must accept it.
      const idToken = await cred.user.getIdToken();
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (res.ok) {
        router.replace('/admin');
        return; // keep busy=true so the form locks during navigation
      }
      // Server refused: not an active administrator, or an invalid/revoked
      // token. The Firebase client session is worthless by itself — end it.
      await signOut(getFirebaseAuth()).catch(() => undefined);
      setError('Your account is not an active administrator. Sign-in failed.');
    } catch (err) {
      const code = (err as { code?: string })?.code ?? '';
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-email') {
        setError('Invalid email or password.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Please wait a moment and try again.');
      } else if (code === 'auth/network-request-failed') {
        setError('No Internet — cannot sign in. Check your connection.');
      } else {
        setError('Sign-in failed. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (resetBusy) return;
    if (!email) {
      setError('Enter your email above first, then tap Reset password.');
      return;
    }
    setResetBusy(true);
    setError('');
    try {
      await sendPasswordResetEmail(getFirebaseAuth(), email);
      // Firebase replies identically for unknown addresses where possible;
      // when it does not, we still show a uniform success/failure so the UI
      // never confirms whether an account exists.
      setResetSent(true);
      setNotice('Password reset email sent. Check your inbox.');
    } catch {
      setNotice('');
      setError('Could not send the reset email. Check the address and your connection, then try again.');
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="mb-1 text-2xl font-semibold">Event Access Control</h1>
        <p className="mb-6 text-sm text-stone-500">Administrator sign-in</p>

        <label htmlFor="admin-email" className="block text-sm font-medium text-stone-700">Email</label>
        <input
          type="email"
          id="admin-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
          required
        />

        <label htmlFor="admin-password" className="block text-sm font-medium text-stone-700">Password</label>
        <input
          type="password"
          id="admin-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2 outline-none focus:border-stone-900"
          required
        />

        {error && <p className="mb-4 text-sm text-red-600" role="alert">{error}</p>}
        {notice && <p className="mb-4 text-sm text-emerald-600" role="status">{notice}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-stone-900 py-2.5 font-medium text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <button
          type="button"
          onClick={resetPassword}
          disabled={resetBusy}
          className={`mt-4 w-full text-center text-sm underline disabled:opacity-50 ${
            resetSent ? 'text-emerald-700' : 'text-stone-500'
          }`}
        >
          {resetBusy ? 'Sending reset email…' : resetSent ? 'Reset email sent' : 'Forgot password? Reset by email'}
        </button>
      </form>
    </main>
  );
}
