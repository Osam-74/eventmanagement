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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
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
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, []);

  async function signOut() {
    await fetch('/api/usher/signout', { method: 'POST' }).catch(() => undefined);
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

  async function startScanner() {
    setStarting(true);
    setCameraError('');
    try {
      const { default: QrScannerCtor } = await import('qr-scanner');
      // The camera-shows-but-never-decodes symptom we chased with the old
      // library traced back to the native BarcodeDetector path silently
      // detecting nothing on some Android builds. qr-scanner uses
      // BarcodeDetector when present too — force it off so every device
      // runs the same battle-tested WASM/worker decoder, on a dedicated
      // thread (this is also what makes it feel genuinely "live": decoding
      // never blocks the main thread/UI the way the old canvas-based
      // decode loop could).
      (QrScannerCtor as unknown as { _disableBarcodeDetector: boolean })._disableBarcodeDetector = true;

      const video = videoRef.current;
      if (!video) throw new Error('Video element not mounted');

      const scanner = new QrScannerCtor(
        video,
        (result) => submitToken(result.data),
        {
          onDecodeError: () => undefined, // fires every frame with no code — expected noise
          highlightScanRegion: true,
          highlightCodeOutline: true,
          maxScansPerSecond: 12,
          preferredCamera: 'environment',
        }
      );
      scannerRef.current = scanner;
      await scanner.start();
      setScanning(true);
      setResult(null);
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
        setCameraError('Could not start the camera. Tap Start Scanner again, or use manual entry below.');
      }
      scannerRef.current?.destroy();
      scannerRef.current = null;
    } finally {
      setStarting(false);
    }
  }

  async function stopScanner() {
    scannerRef.current?.stop();
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

        <div className="mt-4">
          {/* ALWAYS mounted (never display:none/unmounted): qr-scanner attaches
              its live decode loop directly to this <video> element, so it must
              already exist in the DOM before start() runs. muted+playsInline
              are required for iOS Safari to actually play the stream inline
              instead of forcing fullscreen (which breaks frame capture). */}
          <video
            id="qr-video"
            ref={videoRef}
            muted
            playsInline
            className="w-full rounded-xl bg-stone-950"
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
