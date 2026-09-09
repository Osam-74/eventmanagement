'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Html5Qrcode } from 'html5-qrcode';

type UsherEvent = { id: string; name: string; slug: string };

type SessionInfo = {
  usherName: string;
  gateId: string | null;
  acceptedCount: number;
  eventId: string;
  eventName: string;
  scanningEnabled: boolean;
  lifecycleStatus: string | null;
};

type ScanResult =
  | { kind: 'granted'; serial: string | null; at: string | null }
  | { kind: 'denied'; code: string; message: string; serial: string | null; firstUsedAt?: string | null }
  | { kind: 'error'; message: string };

const COOLDOWN_MS = 2500;

function beep(good: boolean) {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = good ? 880 : 220;
    gain.gain.value = 0.15;
    osc.start();
    osc.stop(ctx.currentTime + (good ? 0.15 : 0.4));
    setTimeout(() => ctx.close(), 800);
  } catch {
    /* audio unavailable */
  }
  if (navigator.vibrate) navigator.vibrate(good ? 80 : [100, 60, 100]);
}

export default function ScannerPage() {
  // ---- sign-in state ----
  const [events, setEvents] = useState<UsherEvent[]>([]);
  const [eventId, setEventId] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [signinError, setSigninError] = useState('');

  // ---- session state ----
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [online, setOnline] = useState(true);
  const [sessionAccepted, setSessionAccepted] = useState(0);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const busyRef = useRef(false);
  const lastTokenRef = useRef<{ token: string; at: number }>({ token: '', at: 0 });

  useEffect(() => {
    fetch('/api/usher/events').then((r) => r.json()).then((b) => setEvents(b.events ?? [])).catch(() => undefined);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    setOnline(navigator.onLine);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const refreshSession = useCallback(() => {
    fetch('/api/usher/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.session) setSession(b.session);
        else if (b?.disabled) setSession(null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!session) return;
    refreshSession();
    const t = setInterval(refreshSession, 10000);
    return () => clearInterval(t);
  }, [session !== null, refreshSession]);

  // heartbeat
  useEffect(() => {
    if (!session) return;
    const beat = () =>
      fetch('/api/usher/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .catch(() => undefined);
    beat();
    const t = setInterval(beat, 45000);
    return () => clearInterval(t);
  }, [session !== null]);

  useEffect(() => {
    return () => {
      const s = scannerRef.current;
      if (s) s.stop().then(() => s.clear()).catch(() => undefined);
    };
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setSigninError('');
    const res = await fetch('/api/usher/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, name, pin }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      fetch('/api/usher/session').then((r) => r.json()).then((b) => setSession(b.session ?? null)).catch(() => undefined);
      setPin('');
    } else {
      setSigninError(body.message ?? 'Sign-in failed.');
    }
  }

  async function signOut() {
    await fetch('/api/usher/signout', { method: 'POST' }).catch(() => undefined);
    if (scannerRef.current) {
      scannerRef.current.stop().catch(() => undefined);
    }
    setSession(null);
    setScanning(false);
  }

  async function submitToken(token: string, gateId?: string | null) {
    const now = Date.now();
    if (
      busyRef.current ||
      (lastTokenRef.current.token === token && now - lastTokenRef.current.at < 5000)
    ) {
      return;
    }
    busyRef.current = true;
    lastTokenRef.current = { token, at: now };
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          clientRequestId: crypto.randomUUID(),
          gateId: gateId ?? session?.gateId ?? null,
          deviceInfo: navigator.userAgent.slice(0, 200),
        }),
      });
      if (res.status === 401) {
        setSession(null);
        setScanning(false);
        return;
      }
      const body = await res.json();
      if (body.code === 'ACCEPTED') {
        setResult({ kind: 'granted', serial: body.serialNumber ?? null, at: body.checkedInAt ?? null });
        setSessionAccepted((c) => c + 1);
        setSession((s) => (s ? { ...s, acceptedCount: s.acceptedCount + 1 } : s));
        beep(true);
      } else {
        setResult({
          kind: 'denied',
          code: body.code,
          message: body.message,
          serial: body.serialNumber ?? null,
          firstUsedAt: body.firstUsedAt ?? null,
        });
        beep(false);
      }
    } catch {
      setResult({ kind: 'error', message: 'Network error — invitation NOT validated. Do not admit. Check connection and scan again.' });
    } finally {
      setTimeout(() => {
        busyRef.current = false;
      }, COOLDOWN_MS);
    }
  }

  async function startScanner() {
    setStarting(true);
    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      const scanner = new Html5Qrcode('qr-reader', { verbose: false });
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => submitToken(decodedText),
        () => undefined
      );
      setScanning(true);
      setResult(null);
    } catch {
      setSigninError('Could not start the camera. Allow camera permission and use Chrome/Safari on the phone.');
    } finally {
      setStarting(false);
    }
  }

  async function stopScanner() {
    const s = scannerRef.current;
    if (s) {
      await s.stop().catch(() => undefined);
      s.clear();
    }
    scannerRef.current = null;
    setScanning(false);
  }

  // ---------------- sign-in screen ----------------
  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <form onSubmit={signIn} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
          <h1 className="mb-1 text-2xl font-semibold">Gate Scanner</h1>
          <p className="mb-6 text-sm text-stone-500">Usher sign-in with your name and PIN</p>

          <label className="block text-sm font-medium text-stone-700">Event</label>
          <select value={eventId} onChange={(e) => setEventId(e.target.value)} className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2.5" required>
            <option value="">Choose event…</option>
            {events.map((ev) => (
              <option key={ev.id} value={ev.id}>{ev.name}</option>
            ))}
          </select>

          <label className="block text-sm font-medium text-stone-700">Your name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2.5" required />

          <label className="block text-sm font-medium text-stone-700">PIN</label>
          <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} className="mt-1 mb-4 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-2xl tracking-widest" required />

          {signinError && <p className="mb-4 text-sm text-red-600">{signinError}</p>}

          <button disabled={!eventId} className="w-full rounded-lg bg-stone-900 py-3 font-semibold text-white disabled:opacity-40">
            Sign in
          </button>
        </form>
      </main>
    );
  }

  // ---------------- scanner screen ----------------
  const disabledBanner = !session.scanningEnabled;

  return (
    <main className="min-h-screen bg-stone-900 text-white">
      <div className="mx-auto max-w-md px-4 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold">{session.usherName}</p>
            <p className="text-sm text-stone-400">
              {session.eventName} {session.gateId ? `· Gate: ${session.gateId}` : ''}
            </p>
          </div>
          <button onClick={signOut} className="rounded-lg border border-stone-600 px-3 py-1.5 text-sm">
            Sign out
          </button>
        </div>

        <div className="mt-3 flex gap-2 text-xs">
          <span className={`rounded px-2 py-1 ${online ? 'bg-stone-700' : 'bg-red-600'}`}>
            {online ? 'Online' : 'OFFLINE — cannot validate'}
          </span>
          <span className={`rounded px-2 py-1 ${session.scanningEnabled ? 'bg-emerald-600' : 'bg-red-600'}`}>
            {session.scanningEnabled ? 'Scanning ACTIVE' : 'EVENT NOT OPEN'}
          </span>
          <span className="rounded bg-stone-700 px-2 py-1">Admitted: {sessionAccepted}</span>
        </div>

        {disabledBanner && (
          <div className="mt-4 rounded-lg bg-red-600 p-4 text-center text-lg font-bold">
            EVENT NOT OPEN — SCANNING DISABLED
          </div>
        )}

        {!scanning ? (
          <div className="mt-8 text-center">
            <button
              onClick={startScanner}
              disabled={starting}
              className="w-full rounded-2xl bg-emerald-600 py-6 text-2xl font-bold disabled:opacity-50"
            >
              {starting ? 'Starting camera…' : '▶ Start Scanner'}
            </button>
            <div className="mt-6 text-left">
              <label className="text-sm text-stone-400">Manual entry (camera not working)</label>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const el = e.currentTarget.elements.namedItem('manual') as HTMLInputElement;
                  if (el.value.trim()) submitToken(el.value.trim());
                  el.value = '';
                }}
              >
                <input
                  name="manual"
                  placeholder="IS26.xxxx…"
                  className="mt-1 w-full rounded-lg border border-stone-600 bg-stone-800 px-3 py-2 text-white"
                />
              </form>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <div id="qr-reader" className="overflow-hidden rounded-xl" />
            <button onClick={stopScanner} className="mt-3 w-full rounded-lg border border-stone-600 py-2 text-sm">
              Pause scanner
            </button>
          </div>
        )}

        {result && (
          <div
            className={`mt-5 rounded-2xl p-6 text-center ${
              result.kind === 'granted' ? 'bg-emerald-600' : result.kind === 'denied' ? 'bg-red-600' : 'bg-amber-600'
            }`}
          >
            {result.kind === 'granted' && (
              <>
                <p className="text-3xl font-black tracking-wide">ACCESS GRANTED ✓</p>
                {result.serial && <p className="mt-2 font-mono text-lg">No. {result.serial}</p>}
                <p className="mt-1 text-sm opacity-80">Welcome the guest in</p>
              </>
            )}
            {result.kind === 'denied' && (
              <>
                <p className="text-3xl font-black tracking-wide">{result.code === 'ALREADY_USED' ? 'ALREADY USED ✗' : 'DENIED ✗'}</p>
                <p className="mt-2 text-sm">{result.message}</p>
                {result.serial && <p className="mt-1 font-mono text-sm">No. {result.serial}</p>}
                {result.firstUsedAt && (
                  <p className="mt-1 text-xs opacity-80">
                    First scanned: {new Date(result.firstUsedAt).toLocaleTimeString()} — ask an admin to allow rescan if this was a network error.
                  </p>
                )}
              </>
            )}
            {result.kind === 'error' && <p className="text-xl font-bold">{result.message}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
