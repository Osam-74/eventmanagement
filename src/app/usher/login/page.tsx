'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import InstallPrompt from '@/components/InstallPrompt';

type UsherEvent = { id: string; name: string };

/**
 * Usher sign-in. Name/identifier + 6-digit PIN — no Firebase email/password
 * auth for ushers. The server validates the PIN, lockout and usher active
 * state and sets the HttpOnly usher session cookie; /scan stays protected.
 */
export default function UsherLoginPage() {
  const router = useRouter();
  const [events, setEvents] = useState<UsherEvent[]>([]);
  const [eventId, setEventId] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/usher/events')
      .then((r) => r.json())
      .then((b) => {
        const list: UsherEvent[] = b.events ?? [];
        setEvents(list);
        if (list.length === 1) setEventId(list[0].id);
      })
      .catch(() => undefined);
  }, []);

  // Already signed in with a valid session? Straight to the scanner.
  useEffect(() => {
    fetch('/api/usher/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.session) router.replace('/scan');
      })
      .catch(() => undefined);
  }, [router]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/usher/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, name, pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        router.replace('/scan');
      } else {
        setError(body.message ?? 'Sign-in failed.');
      }
    } catch {
      setError('No Internet — cannot sign in. Check your connection.');
    } finally {
      setBusy(false);
      setPin('');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <h1 className="mb-1 text-2xl font-semibold">Usher Sign In</h1>
        <p className="mb-6 text-sm text-stone-500">Welcome — please sign in with your name and PIN</p>

        <label className="block text-sm font-medium text-stone-700">Event</label>
        <select
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2.5"
          required
        >
          <option value="">Choose event…</option>
          {events.map((ev) => (
            <option key={ev.id} value={ev.id}>
              {ev.name}
            </option>
          ))}
        </select>

        <label htmlFor="usher-name" className="block text-sm font-medium text-stone-700">Usher name / identifier</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          id="usher-name"
          className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2.5"
          required
        />

        <label htmlFor="usher-pin" className="block text-sm font-medium text-stone-700">PIN</label>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          id="usher-pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-2xl tracking-widest"
          required
        />

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <button
          disabled={busy || !eventId}
          className="w-full rounded-lg bg-stone-900 py-3 font-semibold text-white disabled:opacity-40"
        >
          {busy ? 'Signing in…' : 'Sign In'}
        </button>

        <InstallPrompt />
      </form>
    </main>
  );
}
