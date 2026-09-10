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
const SCANNER_CONTAINER_ID = 'qr-reader';

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

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const busyRef = useRef(false);
  const lastTokenRef = useRef<{ token: string; at: number }>({ token: '', at: 0 });
  // Proof-of-life for the decode loop, NOT just camera permission: every
  // processed frame (found or not) bumps this, via html5-qrcode's own public
  // per-frame error callback — no private-field pokes, no reimplementing its
  // internals. If frames stop landing for a while we restart the engine.
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
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop()
          .catch(() => undefined)
          .finally(() => s.clear());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signOut() {
    await fetch('/api/usher/signout', { method: 'POST' }).catch(() => undefined);
    stopWatchdog();
    scannerRef.current?.stop().catch(() => undefined);
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
      // The decoded QR text is NEVER trusted on its own — this call is the
      // one and only security boundary. The server re-derives the HMAC
      // digest from `token`, checks it against the stored invitation inside
      // a Firestore transaction (one admit ever, race-safe), and requires a
      // live, authenticated usher session cookie. A scanner swap on the
      // client changes none of that.
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

  // Starts (or restarts) the decode engine using html5-qrcode's own
  // plain, documented happy path — the exact same construction (fps 10,
  // 250px qrbox, aspectRatio 1.0, facingMode "environment", start/pause/
  // resume) proven to work reliably elsewhere. No private-field pokes, no
  // custom video/canvas plumbing: html5-qrcode owns its own <video> inside
  // the container div, which is what the earlier custom-video approach
  // (across two different libraries) never got right.
  async function startScanner(isRestart = false) {
    setStarting(true);
    if (!isRestart) setCameraError('');
    setStalled(false);
    try {
      const { Html5Qrcode } = await import('html5-qrcode');

      // Any previous instance must be fully torn down before creating a new
      // one — two engines racing over the same container is exactly the kind
      // of state that LOOKS live but never resolves.
      if (scannerRef.current) {
        await scannerRef.current.stop().catch(() => undefined);
        scannerRef.current.clear();
        scannerRef.current = null;
      }

      const scanner = new Html5Qrcode(SCANNER_CONTAINER_ID, { verbose: false });
      scannerRef.current = scanner;

      lastFrameAtRef.current = Date.now();
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 250, aspectRatio: 1.0 },
        (decodedText) => {
          lastFrameAtRef.current = Date.now();
          // Pause while the server round-trip resolves so the same frame
          // doesn't fire twice, then resume automatically — same pattern
          // proven to work, just wired to our own submit/cooldown logic.
          scanner.pause(true);
          submitToken(decodedText);
          setTimeout(() => {
            try {
              scanner.resume();
            } catch {
              /* scanner may have been stopped/torn down in the meantime */
            }
          }, COOLDOWN_MS);
        },
        () => {
          // Fires on every processed frame where no code was found — our
          // proof-of-life signal that the decode loop is actually running.
          lastFrameAtRef.current = Date.now();
        }
      );

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
      // html5-qrcode surfaces getUserMedia's DOMException (with .name)
      // directly, or a plain string/Error when no camera exists —
      // distinguish them so ushers get the RIGHT instruction.
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
      if (scannerRef.current) {
        await scannerRef.current.stop().catch(() => undefined);
        scannerRef.current.clear();
        scannerRef.current = null;
      }
      setScanning(false);
      stopWatchdog();
    } finally {
      setStarting(false);
    }
  }

  async function stopScanner() {
    stopWatchdog();
    await scannerRef.current?.stop().catch(() => undefined);
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
          {/* html5-qrcode owns this container: it creates and manages its own
              <video> element inside it. Must stay mounted (never
              display:none) while a scan session is active. min-height stops
              layout collapse before the camera stream attaches. */}
          <div
            id={SCANNER_CONTAINER_ID}
            className="w-full overflow-hidden rounded-xl bg-stone-950"
            style={{ minHeight: '260px' }}
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
