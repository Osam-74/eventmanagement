'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type QrScanner from 'qr-scanner';
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
  const [cameraError, setCameraError] = useState('');
  const [stalled, setStalled] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const busyRef = useRef(false);
  const lastTokenRef = useRef<{ token: string; at: number }>({ token: '', at: 0 });
  // Proof-of-life for the decode loop, NOT just camera permission: every
  // processed frame (found or not) bumps this. A watchdog below compares it
  // against "now" — if frames stop landing this catches the exact bug we
  // were chasing (video visibly live, decode engine silently dead/never
  // initialized) instead of leaving the UI stuck showing "scanning" forever.
  const lastFrameAtRef = useRef<number>(0);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartingRef = useRef(false);

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
      stopWatchdog();
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, []);

  async function signOut() {
    await fetch('/api/usher/signout', { method: 'POST' }).catch(() => undefined);
    stopWatchdog();
    scannerRef.current?.stop();
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

  function stopWatchdog() {
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
  }

  // Starts (or restarts) the decode engine and arms a watchdog that proves
  // frames are actually being PROCESSED, not just that the camera opened.
  // This is the real fix for "camera looks live but nothing ever scans":
  // that symptom means getUserMedia succeeded (video renders) while the
  // decode loop never produced a single callback — previously invisible,
  // now caught and auto-recovered within a few seconds.
  async function startScanner(isRestart = false) {
    setStarting(true);
    if (!isRestart) setCameraError('');
    setStalled(false);
    try {
      const { default: QrScannerCtor } = await import('qr-scanner');

      // qr-scanner opportunistically uses the browser's native
      // BarcodeDetector API when the device reports support for it
      // (https://web.dev/shape-detection/). On a real, non-trivial slice of
      // Android/Chrome installs that native detector self-reports as
      // supported while its underlying Google Play Services ML Kit module
      // is missing/broken on-device — detect() then just keeps returning
      // ZERO results forever, completely silently: no error, no rejected
      // promise, camera preview looks perfectly normal. That is the exact,
      // previously invisible root cause of "camera live, nothing ever
      // scans" — it happens INSIDE the library's own engine selection,
      // beneath any of our code, which is why swapping wrapper libraries
      // never fixed it. Forcing the library's own bundled jsQR/ZXing worker
      // decoder — the same reliable, cross-device-consistent decode path
      // the confirmed-working reference implementation relies on — removes
      // this failure mode for good.
      // Accessing a private static field: intentional (see comment above) —
      // ts-expect-error rather than a silent cast, so this loudly breaks if
      // a future qr-scanner version renames/removes the field, forcing us
      // to re-verify the workaround instead of it quietly rotting.
      // @ts-expect-error intentional access to qr-scanner's private kill-switch for native BarcodeDetector
      QrScannerCtor._disableBarcodeDetector = true;

      const video = videoRef.current;
      if (!video) throw new Error('Video element not mounted');

      // Any previous instance must be fully torn down before creating a new
      // one — two QrScanner instances racing over the same <video> element
      // is exactly the kind of state that LOOKS live but never resolves.
      scannerRef.current?.destroy();
      scannerRef.current = null;

      lastFrameAtRef.current = Date.now();
      const scanner = new QrScannerCtor(
        video,
        (result) => {
          lastFrameAtRef.current = Date.now();
          submitToken(result.data);
        },
        {
          // Fires on EVERY processed frame that found no code — this is our
          // proof-of-life signal, not noise to discard.
          onDecodeError: () => {
            lastFrameAtRef.current = Date.now();
          },
          highlightScanRegion: true,
          highlightCodeOutline: true,
          maxScansPerSecond: 15,
          preferredCamera: 'environment',
          returnDetailedScanResult: true,
        }
      );
      scannerRef.current = scanner;
      await scanner.start();
      // Forces the internal decode-engine promise to be awaited right now
      // (hasFlash() reads it) so a broken engine (e.g. worker init failure)
      // throws HERE, as a visible camera error, instead of hanging silently
      // forever inside the per-frame decode loop.
      await scanner.hasFlash().catch(() => undefined);

      setScanning(true);
      setResult(null);

      stopWatchdog();
      watchdogRef.current = setInterval(() => {
        const silentMs = Date.now() - lastFrameAtRef.current;
        if (silentMs > 6000 && !restartingRef.current) {
          restartingRef.current = true;
          setStalled(true);
          startScanner(true).finally(() => {
            restartingRef.current = false;
          });
        }
      }, 2000);
    } catch (e) {
      // qr-scanner surfaces getUserMedia's DOMException (with .name) directly,
      // or a plain string/Error when no camera exists — distinguish them so
      // ushers get the RIGHT instruction, not a generic one.
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
        setCameraError('The camera opened but the scanner engine failed to start. Tap Start Scanner again, or use manual entry below.');
      }
      scannerRef.current?.destroy();
      scannerRef.current = null;
      setScanning(false);
      stopWatchdog();
    } finally {
      setStarting(false);
    }
  }

  async function stopScanner() {
    stopWatchdog();
    scannerRef.current?.stop();
    setScanning(false);
    setStalled(false);
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
          <span className="rounded bg-stone-700 px-2 py-1">Admitted: {session.acceptedCount}</span>
        </div>

        {disabledBanner && (
          <div className="mt-4 rounded-lg bg-red-600 p-4 text-center text-lg font-bold">
            EVENT NOT OPEN — SCANNING DISABLED
          </div>
        )}

        {cameraError && (
          <div className="mt-4 rounded-lg bg-amber-600 p-4 text-sm font-medium">{cameraError}</div>
        )}

        {stalled && (
          <div className="mt-4 rounded-lg bg-amber-500/90 p-3 text-center text-sm font-medium">
            Decoder went quiet — restarting the scanner automatically…
          </div>
        )}

        <div className="mt-4">
          {/* ALWAYS mounted (never display:none/unmounted): qr-scanner attaches
              its live decode loop directly to this <video> element, so it must
              already exist in the DOM before start() runs. muted+playsInline
              are required for iOS Safari to actually play the stream inline
              instead of forcing fullscreen (which breaks frame capture).
              min-h ensures it never collapses to 0px before video metadata
              loads — a zero-size element was one of the candidate causes of
              "camera looks on but nothing scans" and costs nothing to rule out. */}
          <video
            id="qr-video"
            ref={videoRef}
            muted
            playsInline
            style={{ minHeight: '260px' }}
            className="w-full rounded-xl bg-stone-950 object-cover"
          />
          {scanning && (
            <button onClick={stopScanner} className="mt-3 w-full rounded-lg border border-stone-600 py-2 text-sm">
              Pause scanner
            </button>
          )}
        </div>

        {!scanning ? (
          <div className="mt-8 text-center">
            <button
              onClick={() => startScanner(false)}
              disabled={starting}
              className="w-full rounded-2xl bg-emerald-600 py-6 text-2xl font-bold disabled:opacity-50"
            >
              {starting ? 'Starting camera…' : '▶ Start Scanner'}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-center text-sm text-stone-400">
            {stalled ? 'Reconnecting the decoder…' : 'Live — point the camera at the invitation QR, it scans automatically.'}
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
