'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Html5Qrcode } from 'html5-qrcode';
import { shouldSubmitToken } from '@/lib/client/scanClient';

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
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [online, setOnline] = useState(true);
  const [sessionAccepted, setSessionAccepted] = useState(0);
  const [cameraError, setCameraError] = useState('');

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const busyRef = useRef(false);
  const lastTokenRef = useRef<{ token: string; at: number }>({ token: '', at: 0 });

  useEffect(() => {
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

  // Initial gate: unauthenticated or disabled usher → usher login.
  useEffect(() => {
    fetch('/api/usher/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.session) {
          setSession(b.session);
        } else {
          router.replace('/usher/login');
        }
      })
      .catch(() => {
        setChecking(false);
      });
  }, [router]);

  const refreshSession = useCallback(() => {
    fetch('/api/usher/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.session) setSession(b.session);
        else if (b?.disabled) router.replace('/usher/login');
      })
      .catch(() => undefined);
  }, [router]);

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

  async function signOut() {
    await fetch('/api/usher/signout', { method: 'POST' }).catch(() => undefined);
    if (scannerRef.current) {
      scannerRef.current.stop().catch(() => undefined);
    }
    setSession(null);
    setScanning(false);
    router.replace('/usher/login');
  }

  async function submitToken(token: string, gateId?: string | null) {
    const now = Date.now();
    if (!shouldSubmitToken({ busy: busyRef.current, lastToken: lastTokenRef.current.token, lastAt: lastTokenRef.current.at }, token, now)) {
      return;
    }
    // Connectivity pre-check (UX only — the server transaction remains the
    // sole authority; offline requests are never fabricated as granted).
    if (!navigator.onLine) {
      setResult({ kind: 'error', message: 'No Internet — invitation NOT validated. Do not admit. Reconnect and scan again.' });
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
        router.replace('/usher/login');
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
    setCameraError('');
    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      // #qr-reader is ALWAYS mounted (below), so the library can attach its
      // video element and actually call getUserMedia — the browser permission
      // prompt only appears if the container exists at this moment.
      // useBarCodeDetectorIfSupported: false is critical on Android Chrome:
      // the native BarcodeDetector path can silently detect NOTHING (camera
      // shows, QR never fires) on several devices/versions — forcing the
      // battle-tested pure-JS decoder makes detection reliable everywhere.
      const scanner = new Html5Qrcode('qr-reader', {
        verbose: false,
        useBarCodeDetectorIfSupported: false,
      });
      scannerRef.current = scanner;
      // fps 15 = fast pickup; qrbox as a function keeps the scan region
      // responsive (70% of the viewfinder) so ushers don't have to aim
      // precisely — point at the card and it reads.
      const config = {
        fps: 15,
        qrbox: (vw: number, vh: number) => {
          const edge = Math.floor(Math.min(vw, vh) * 0.7);
          return { width: edge, height: edge };
        },
      };
      const onScan = (decodedText: string) => submitToken(decodedText);
      try {
        // NOTE: html5-qrcode requires this object to have EXACTLY ONE key
        // ({facingMode} or {deviceId}) — adding width/height constraints
        // here throws "should have exactly 1 key" and the camera never starts.
        await scanner.start({ facingMode: 'environment' }, config, onScan, () => undefined);
      } catch (e) {
        // Devices without a rear camera (e.g. laptops) can reject the
        // facingMode constraint — fall back to any available camera.
        const name = (e as { name?: string })?.name ?? '';
        if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
          await scanner.start({}, config, onScan, () => undefined);
        } else {
          throw e;
        }
      }
      setScanning(true);
      setResult(null);
    } catch (e) {
      // html5-qrcode throws plain strings for its own errors and
      // DOMExceptions (with .name) for getUserMedia failures — distinguish
      // them so ushers get the RIGHT instruction, not a generic one.
      const name = (e as { name?: string })?.name ?? String(e);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraError(
          'Camera permission was denied. Tap the ⓘ icon next to the address bar (or Settings → Site permissions → Camera), allow Camera for this site, then tap Start Scanner again.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setCameraError('No camera was found on this device. Use manual entry below.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        setCameraError('The camera is in use by another app. Close other camera apps, then tap Start Scanner again.');
      } else {
        setCameraError('Could not start the camera. Tap Start Scanner again, or use manual entry below.');
      }
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

  // ---------------- gate: session required ----------------
  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-stone-500">{checking ? 'Loading…' : 'Redirecting to usher sign-in…'}</p>
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

        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <span className={`rounded px-2 py-1 ${online ? 'bg-stone-700' : 'bg-red-600'}`}>
            {online ? 'Online' : 'No Internet'}
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

        {cameraError && (
          <div className="mt-4 rounded-lg bg-amber-600 p-4 text-sm font-medium">{cameraError}</div>
        )}

        <div className="mt-4">
          {/* ALWAYS mounted and never display:none: html5-qrcode needs a
              real container (with layout) when start() runs, or it throws or
              stalls before requesting the camera — no permission prompt would
              ever appear. Empty div = zero height, so it's invisible until
              the scanner injects its video. */}
          <div id="qr-reader" className="overflow-hidden rounded-xl" />
          {scanning && (
            <button onClick={stopScanner} className="mt-3 w-full rounded-lg border border-stone-600 py-2 text-sm">
              Pause scanner
            </button>
          )}
        </div>

        {!scanning ? (
          <div className="mt-8 text-center">
            <button
              onClick={startScanner}
              disabled={starting}
              className="w-full rounded-2xl bg-emerald-600 py-6 text-2xl font-bold disabled:opacity-50"
            >
              {starting ? 'Starting camera…' : '▶ Start Scanner'}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-center text-sm text-stone-400">
            Point the camera at the invitation QR — it scans automatically.
          </p>
        )}

        {/* Manual entry: always available, including while the camera runs.
            Type the serial number printed on the card — with or without the
            hyphen, any case; the server matches both stored serial shapes. */}
        <div className="mt-6 text-left">
          <label htmlFor="manual-entry" className="text-sm text-stone-400">
            Manual entry — type the serial on the card
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const el = e.currentTarget.elements.namedItem('manual') as HTMLInputElement;
              if (el.value.trim()) submitToken(el.value.trim());
              el.value = '';
            }}
          >
            <div className="mt-1 flex gap-2">
              <input
                name="manual"
                id="manual-entry"
                placeholder="e.g. ISWED00042"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-stone-600 bg-stone-800 px-3 py-2 font-mono uppercase tracking-wide text-white"
              />
              <button
                type="submit"
                className="shrink-0 rounded-lg bg-stone-700 px-5 py-2 font-semibold text-white"
              >
                Check
              </button>
            </div>
          </form>
        </div>

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
