'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
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
      // continueUrl (owner request, 2026-09-11): Firebase's own hosted
      // reset-password page then offers a link straight back here once
      // the password is set, instead of dead-ending the admin.
      await sendPasswordResetEmail(getFirebaseAuth(), email, { url: `${window.location.origin}/login` });
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
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-brand-blush px-4 py-10">
      <div className="relative z-10 flex w-full max-w-sm flex-col items-center">
        <div className="mb-7 flex flex-col items-center gap-3">
          <Image src="/brand/mark.png" alt="Event Access" width={64} height={64} className="drop-shadow-[0_8px_20px_rgba(11,99,230,0.15)]" priority />
          <div className="text-center">
            <p className="text-base font-semibold tracking-wide text-brand-navy-900">
              EVENT<span className="text-brand-blue-500"> ACCESS</span>
            </p>
            <p className="text-xs uppercase tracking-[0.2em] text-brand-navy-700/50">Event management platform</p>
          </div>
        </div>

        <form
          onSubmit={signIn}
          className="w-full rounded-2xl border border-brand-ice-200 bg-white p-8 shadow-brand"
        >
          <h1 className="mb-1 text-xl font-semibold text-brand-navy-900">Administrator sign-in</h1>
          <p className="mb-6 text-sm text-brand-navy-700/60">Sign in to manage events, guests and access.</p>

          <label htmlFor="admin-email" className="block text-sm font-medium text-brand-navy-800">Email</label>
          <input
            type="email"
            id="admin-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 mb-4 w-full rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2.5 text-brand-navy-900 outline-none transition focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20"
            required
          />

          <label htmlFor="admin-password" className="block text-sm font-medium text-brand-navy-800">Password</label>
          <input
            type="password"
            id="admin-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 mb-4 w-full rounded-lg border border-brand-ice-200 bg-brand-ice-50 px-3 py-2.5 text-brand-navy-900 outline-none transition focus:border-brand-blue-500 focus:bg-white focus:ring-2 focus:ring-brand-blue-500/20"
            required
          />

          {error && <p className="mb-4 text-sm text-red-600" role="alert">{error}</p>}
          {notice && <p className="mb-4 text-sm text-emerald-600" role="status">{notice}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-blue-500 py-2.5 font-medium text-white transition hover:bg-brand-blue-600 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <button
            type="button"
            onClick={resetPassword}
            disabled={resetBusy}
            className={`mt-4 w-full text-center text-sm underline underline-offset-2 disabled:opacity-50 ${
              resetSent ? 'text-emerald-700' : 'text-brand-teal-600 hover:text-brand-teal-500'
            }`}
          >
            {resetBusy ? 'Sending reset email…' : resetSent ? 'Reset email sent' : 'Forgot password? Reset by email'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-brand-navy-700/40">© {new Date().getFullYear()} Event Access</p>
      </div>
    </main>
  );
}
