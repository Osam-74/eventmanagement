'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import InstallPrompt from '@/components/InstallPrompt';

/**
 * Usher sign-in: PIN only. The PIN pad interaction follows the reference
 * pattern from the Flo app's PinScreen: six indicator dots, a 3-column
 * numeric keypad, automatic submission as soon as the PIN is complete,
 * shake-and-reset feedback for a wrong PIN, and a brief welcome overlay
 * showing the identified usher before the scanner opens.
 *
 * Event Access keeps its own server-side security: the PIN is verified
 * SERVER-SIDE (peppered digest + atomic registry lookup, lockout, active
 * state) and the browser submits nothing but the PIN digits — no name,
 * no event, no client-side credential storage.
 */
const PIN_LENGTH = 6;
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export default function UsherLoginPage() {
  const router = useRouter();

  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [shaking, setShaking] = useState(false);
  const [dotError, setDotError] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [welcome, setWelcome] = useState<{ name: string } | null>(null);

  const busyRef = useRef(false);

  // Already signed in with a valid server session? Straight to the scanner.
  useEffect(() => {
    fetch('/api/usher/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.session) router.replace('/scan');
      })
      .catch(() => undefined);
  }, [router]);

  const resetEntry = useCallback((afterMs: number) => {
    setTimeout(() => {
      setEntry('');
      setDotError(false);
      setShaking(false);
      setError('');
      busyRef.current = false;
    }, afterMs);
  }, []);

  const showError = useCallback(
    (msg: string) => {
      setDotError(true);
      setShaking(true);
      setError(msg);
      resetEntry(900);
    },
    [resetEntry]
  );

  const submitPin = useCallback(
    async (pin: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setVerifying(true);
      setError('');
      try {
        const res = await fetch('/api/usher/signin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          // Success: identify the usher briefly, then open the scanner.
          setDotError(false);
          setError('');
          setWelcome({ name: body.usherName });
          setMessage('');
          setTimeout(() => router.replace('/scan'), 1400);
          return; // busyRef stays true — we are done with this pad
        }
        showError(body.message ?? 'Invalid PIN.');
        busyRef.current = false; // unlock the pad for the next attempt
      } catch {
        showError('No Internet — cannot sign in. Check your connection.');
        busyRef.current = false;
      } finally {
        setVerifying(false);
      }
    },
    [router, showError]
  );

  const press = useCallback(
    (d: string) => {
      if (busyRef.current || welcome) return;
      setEntry((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = prev + d;
        if (next.length === PIN_LENGTH) {
          setTimeout(() => submitPin(next), 120); // auto-check on completion
        }
        return next;
      });
    },
    [submitPin, welcome]
  );

  const del = useCallback(() => {
    if (busyRef.current) return;
    setEntry((prev) => prev.slice(0, -1));
  }, []);

  const confirm = useCallback(() => {
    if (entry.length === PIN_LENGTH && !busyRef.current) submitPin(entry);
  }, [entry, submitPin]);

  // Physical keyboard support (testing + desktop kiosks).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') press(e.key);
      else if (e.key === 'Backspace') del();
      else if (e.key === 'Enter') confirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [press, del, confirm]);

  return (
    <main className="flex min-h-screen select-none flex-col items-center justify-center bg-brand-blush px-6">
      <style>{`
        @keyframes pin-shake {
          0%,100% { transform: translateX(0); }
          20%,60% { transform: translateX(-8px); }
          40%,80% { transform: translateX(8px); }
        }
        .pin-shake { animation: pin-shake 0.45s ease; }
        @keyframes pin-pulse {
          0%,100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        .pin-verifying { animation: pin-pulse 0.9s ease-in-out infinite; }
        @keyframes welcome-fade {
          0% { opacity: 0; }
          12% { opacity: 1; }
          82% { opacity: 1; }
          100% { opacity: 0; }
        }
      `}</style>

      {/* Welcome overlay — identifies the resolved usher before the scanner. */}
      {welcome && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-brand-navy-950"
          style={{ animation: 'welcome-fade 1.4s forwards' }}
        >
          <p className="text-sm uppercase tracking-widest text-brand-ice-200/60">Welcome</p>
          <p className="mt-2 text-3xl font-semibold text-white">{welcome.name}</p>
          <p className="mt-6 text-xs text-brand-ice-200/50">Opening the scanner…</p>
        </div>
      )}

      <Link href="/" className="absolute left-5 top-5 text-sm text-brand-navy-700/50 hover:text-brand-navy-900">
        ← Back
      </Link>

      <Image src="/brand/mark.png" alt="Event Access" width={44} height={44} className="mb-3" />
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-brand-navy-900">Event Access</h1>
      <p className="mb-1 text-xs uppercase tracking-widest text-brand-navy-700/50">Usher sign-in</p>
      <p className="mb-8 text-xs text-brand-navy-700/40">Enter your PIN</p>

      {/* PIN indicator dots */}
      <div className={`mb-10 flex gap-4 ${shaking ? 'pin-shake' : ''}`}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => {
          const filled = i < entry.length;
          const err = dotError;
          return (
            <div
              key={i}
              className={`h-3.5 w-3.5 rounded-full transition-all ${
                err
                  ? 'bg-red-600 shadow-[0_0_0_4px_rgba(220,38,38,0.2)]'
                  : filled
                    ? 'bg-brand-navy-900 shadow-[0_0_0_4px_rgba(5,21,49,0.15)]'
                    : 'bg-brand-ice-200'
              } ${verifying && filled ? 'pin-verifying' : ''}`}
            />
          );
        })}
      </div>

      {/* Message area — lockout, disabled, offline, wrong PIN */}
      <div className="mb-6 h-10 text-center">
        {error && (
          <p className={`text-sm font-medium ${dotError ? 'text-red-600' : 'text-brand-navy-700'}`}>{error}</p>
        )}
        {message && <p className="text-sm text-brand-navy-700/60">{message}</p>}
      </div>

      {/* Keypad */}
      <div className="grid w-full max-w-xs grid-cols-3 gap-3">
        {KEYS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => press(k)}
            aria-label={`Digit ${k}`}
            className="h-16 rounded-2xl border border-brand-ice-200 bg-white text-2xl font-semibold text-brand-navy-900 shadow-sm transition active:scale-95 active:bg-brand-ice-50"
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          onClick={del}
          aria-label="Delete last digit"
          className="h-16 rounded-2xl border border-brand-ice-200 bg-white text-xl text-brand-navy-700/60 shadow-sm transition active:scale-95 active:bg-brand-ice-50"
        >
          ⌫
        </button>
        <button
          type="button"
          onClick={() => press('0')}
          aria-label="Digit 0"
          className="h-16 rounded-2xl border border-brand-ice-200 bg-white text-2xl font-semibold text-brand-navy-900 shadow-sm transition active:scale-95 active:bg-brand-ice-50"
        >
          0
        </button>
        <button
          type="button"
          onClick={confirm}
          aria-label="Confirm PIN"
          className="h-16 rounded-2xl bg-brand-navy-900 text-xl font-semibold text-white shadow-sm transition active:scale-95 hover:bg-brand-navy-800 disabled:opacity-40"
          disabled={entry.length < PIN_LENGTH || busyRef.current}
        >
          ✓
        </button>
      </div>

      <div className="mt-10">
        <InstallPrompt />
      </div>
    </main>
  );
}
