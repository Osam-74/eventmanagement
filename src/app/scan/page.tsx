'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type QrScanner from 'qr-scanner';
import { shouldSubmitToken, shouldSleepFromInactivity } from '@/lib/client/scanClient';

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
  | { kind: 'granted'; serial: string | null; tag: string | null; at: string | null; usageCount?: number; usageLimit?: number | null }
  | { kind: 'denied'; code: string; message: string; serial: string | null; tag: string | null; firstUsedAt?: string | null }
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

// Good morning / afternoon / evening — purely cosmetic and computed only
// once this authenticated screen actually renders (session is always null
// during the initial SSR pass, so there is no hydration-mismatch risk here).
function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning,';
  if (h < 18) return 'Good afternoon,';
  return 'Good evening,';
}

function ScanFrameIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2M20 8V6a2 2 0 0 0-2-2h-2M20 16v2a2 2 0 0 1-2 2h-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M15 17l4-5-4-5M19 12H8M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function ScannerPage() {
  const router = useRouter();

  const [checking, setChecking] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  // Bumped every time a NEW result is shown — used as the toast's React
  // `key` so its entrance animation + 3s countdown bar restart cleanly
  // even when two scans in a row land the exact same kind/message
  // (owner request, 2026-09-11: floating popup above the scanner,
  // auto-closes in 3s via a shrinking line, never a numeric countdown).
  const [resultSeq, setResultSeq] = useState(0);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [online, setOnline] = useState(true);
  const [cameraError, setCameraError] = useState('');
  const [decoderReady, setDecoderReady] = useState(false);
  const [processing, setProcessing] = useState(false);

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
  // Battery-saving auto-sleep (owner request, 2026-09-11): bumped on every
  // scan actually PROCESSED (accepted or denied), NOT on every decode-loop
  // frame — a quiet camera pointed at nothing shouldn't count as "active".
  const lastActivityAtRef = useRef<number>(Date.now());
  const inactivityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef<AbortController | null>(null);

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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current++;
      if (cooldownRef.current) clearTimeout(cooldownRef.current);
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
      requestRef.current?.abort();
      stopWatchdog();
      if (inactivityTimerRef.current) clearInterval(inactivityTimerRef.current);
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, []);

  // Battery-saving auto-sleep: while the camera is running, check every 15s
  // for a full INACTIVITY_SLEEP_MS stretch with no scan actually processed.
  // Reuses the exact same stopScanner() path as the manual "Stop Scanner"
  // button, so it lands in the identical, already-tested paused state (the
  // "Start Scanner" card reappears normally — no new control needed).
  useEffect(() => {
    if (!scanning) return;
    inactivityTimerRef.current = setInterval(() => {
      if (shouldSleepFromInactivity(lastActivityAtRef.current, Date.now(), busyRef.current)) {
        void stopScanner();
        setCameraError('Scanner put to sleep after a few minutes of inactivity — no cards scanned. Tap Start Scanner to resume.');
      }
    }, 15000);
    return () => {
      if (inactivityTimerRef.current) {
        clearInterval(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
    };
  }, [scanning]);

  async function signOut() {
    await stopScanner();
    await fetch('/api/usher/signout', { method: 'POST' }).catch(() => undefined);
    stopWatchdog();
    scannerRef.current?.stop();
    setSession(null);
    setScanning(false);
    router.replace('/usher/login');
  }

  // A stray tap at an event entrance must never end a session by accident —
  // confirm before actually signing out (owner request, 2026-09-11).
  function confirmSignOut() {
    if (window.confirm('Sign out? You will need to enter your PIN again to resume scanning.')) {
      void signOut();
    }
  }

  const RESULT_DISPLAY_MS = 3000;

  function showResult(r: ScanResult) {
    if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
    setResult(r);
    setResultSeq((n) => n + 1);
    resultTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setResult(null);
    }, RESULT_DISPLAY_MS);
  }

  async function submitToken(token: string, gateId?: string | null) {
    const now = Date.now();
    if (!shouldSubmitToken({ busy: busyRef.current, lastToken: lastTokenRef.current.token, lastAt: lastTokenRef.current.at }, token, now)) {
      return;
    }
    // Connectivity pre-check (UX only — the server transaction remains the
    // sole authority; offline requests are never fabricated as granted).
    if (!navigator.onLine) {
      showResult({ kind: 'error', message: 'No Internet — invitation NOT validated. Do not admit. Reconnect and scan again.' });
      return;
    }
    busyRef.current = true;
    lastActivityAtRef.current = now;
    setProcessing(true);
    const scanner = scannerRef.current;
    const generation = generationRef.current;
    void scanner?.pause();
    lastTokenRef.current = { token, at: now };
    const controller = new AbortController();
    requestRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          clientRequestId: crypto.randomUUID(),
          gateId: gateId ?? session?.gateId ?? null,
          deviceInfo: navigator.userAgent.slice(0, 200),
        }),
      });
      if (!mountedRef.current) return;
      if (res.status === 401) {
        await stopScanner();
        setSession(null);
        setScanning(false);
        router.replace('/usher/login');
        return;
      }
      const body = await res.json();
      if (!mountedRef.current) return;
      if (body.code === 'ACCEPTED') {
        showResult({
          kind: 'granted',
          serial: body.serialNumber ?? null,
          tag: body.tag ?? null,
          at: body.checkedInAt ?? null,
          usageCount: body.usageCount,
          usageLimit: body.usageLimit,
        });
        setSession((s) => (s ? { ...s, acceptedCount: s.acceptedCount + 1 } : s));
        beep(true);
      } else {
        showResult({
          kind: 'denied',
          code: body.code,
          message: body.message,
          serial: body.serialNumber ?? null,
          tag: body.tag ?? null,
          firstUsedAt: body.firstUsedAt ?? null,
        });
        beep(false);
      }
    } catch {
      if (!mountedRef.current) return;
      showResult({ kind: 'error', message: 'Network error — invitation NOT validated. Do not admit. Check connection and scan again.' });
    } finally {
      clearTimeout(timeout);
      requestRef.current = null;
      if (mountedRef.current) cooldownRef.current = setTimeout(() => {
        busyRef.current = false;
        setProcessing(false);
        if (scanner && generation === generationRef.current && scanner === scannerRef.current) {
          lastFrameAtRef.current = Date.now();
          void scanner.start().catch(() => {
            void stopScanner();
            setCameraError('Scanner could not resume. Tap Start Scanner again.');
          });
        }
      }, COOLDOWN_MS);
    }
  }

  function stopWatchdog() {
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
  }

  // Ready means a frame was processed, not merely that getUserMedia resolved.
  async function startScanner() {
    const generation = ++generationRef.current;
    const current = () => mountedRef.current && generation === generationRef.current;
    setStarting(true);
    setDecoderReady(false);
    setCameraError('');
    try {
      const { default: QrScannerCtor } = await import('qr-scanner');
      if (!current()) return;

      // Retain the existing worker-only decoder while investigating; no library swap.
      // @ts-expect-error intentional access to qr-scanner's private kill-switch for native BarcodeDetector
      QrScannerCtor._disableBarcodeDetector = true;

      const video = videoRef.current;
      if (!video) throw new Error('Video element not mounted');

      // qr-scanner's own _getCameraStream() tries up to six getUserMedia
      // constraint combinations internally and SILENTLY swallows every
      // rejection along the way — DOMException, .name and all — only
      // throwing the generic string "Camera not found." once all six have
      // failed. That means a real NotAllowedError or NotFoundError from the
      // browser never reaches our catch block with its .name intact, so
      // ushers always got the generic "scanner engine failed to start"
      // message instead of the correct permission/no-camera instruction.
      // A direct preflight call surfaces the UNMODIFIED browser error
      // before handing off to qr-scanner, then releases the track
      // immediately — qr-scanner acquires its own stream right after as
      // normal, so this is purely an error-surfacing fix, not a behavior
      // change on the happy path.
      const preflightStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      preflightStream.getTracks().forEach((t) => t.stop());
      if (!current()) return;

      // Any previous instance must be fully torn down before creating a new
      // one — two QrScanner instances racing over the same <video> element
      // is exactly the kind of state that LOOKS live but never resolves.
      scannerRef.current?.destroy();
      scannerRef.current = null;

      lastFrameAtRef.current = Date.now();
      const scanner = new QrScannerCtor(
        video,
        (result) => {
          if (!current()) return;
          lastFrameAtRef.current = Date.now();
          setDecoderReady(true);
          submitToken(result.data);
        },
        {
          // Fires on EVERY processed frame that found no code — this is our
          // proof-of-life signal, not noise to discard.
          onDecodeError: (error) => {
            if (!current()) return;
            if (error === QrScannerCtor.NO_QR_CODE_FOUND) {
              // An actual decoded frame with no symbol proves engine readiness.
              lastFrameAtRef.current = Date.now();
              setDecoderReady(true);
              return;
            }
            // Never log QR credentials. Normal no-code frames stay quiet.
            if (process.env.NODE_ENV !== 'production') console.error('[scanner] Decoder failure', error);
            void stopScanner();
            setCameraError('QR decoder failed. Tap Start Scanner to retry, or use manual entry.');
          },
          // The library's own aim-assist overlay is replaced by our own
          // on-brand corner-bracket frame drawn in JSX below (pure CSS/SVG
          // sitting on top of the video, disabled here to avoid a double
          // overlay) — this flag pair is documented as a purely cosmetic
          // aim-assist aid with zero effect on decode behavior.
          highlightScanRegion: false,
          highlightCodeOutline: false,
          maxScansPerSecond: 15,
          preferredCamera: 'environment',
          returnDetailedScanResult: true,
        }
      );
      scannerRef.current = scanner;
      if (resultTimerRef.current) { clearTimeout(resultTimerRef.current); resultTimerRef.current = null; }
      setResult(null);
      await scanner.start();
      if (!current()) { scanner.destroy(); return; }
      // Camera start is not decoder readiness: only a completed frame above
      // sets decoderReady. hasFlash() checks the camera track, not the worker.

      setScanning(true);
      lastActivityAtRef.current = Date.now();

      stopWatchdog();
      watchdogRef.current = setInterval(() => {
        const silentMs = Date.now() - lastFrameAtRef.current;
        if (silentMs > 6000 && !busyRef.current && !document.hidden) {
          void stopScanner();
          setCameraError('QR decoder is not processing frames. Tap Start Scanner to retry, or use manual entry.');
        }
      }, 2000);
    } catch (e) {
      if (!current()) return;
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
      if (current()) setStarting(false);
    }
  }

  async function stopScanner() {
    generationRef.current++;
    stopWatchdog();
    scannerRef.current?.destroy();
    scannerRef.current = null;
    setStarting(false);
    setDecoderReady(false);
    setScanning(false);
  }

  // ---------------- gate: session required ----------------
  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-brand-blush">
        <p className="text-brand-navy-700/60">{checking ? 'Loading…' : 'Redirecting to usher sign-in…'}</p>
      </main>
    );
  }

  // ---------------- scanner screen ----------------
  const disabledBanner = !session.scanningEnabled;
  const initial = session.usherName.trim().charAt(0).toUpperCase() || '?';

  return (
    <main className="min-h-screen bg-brand-blush text-brand-navy-900">
      <div className="mx-auto max-w-md px-4 py-4 pb-8" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
        {/* ---------------- identity header ---------------- */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-navy-900 text-base font-semibold text-white">
              {initial}
              {/* Connectivity beacon — a beaming dot on the avatar instead of
                  a plain "Online" text label (owner decision 2026-09-10).
                  The status word is still present for screen readers (and
                  kept EXACTLY as before for automated checks — "Online" /
                  "No Internet") via sr-only text on the beacon. */}
              <span
                className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-brand-blush ring-2 ring-brand-blush"
                title={online ? 'Online' : 'No Internet'}
              >
                {online && <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400 opacity-75" />}
                <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-red-500'}`} />
                <span className="sr-only">{online ? 'Online' : 'No Internet'}</span>
              </span>
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-brand-navy-700/55">{getGreeting()}</p>
              <p className="truncate text-base font-semibold leading-tight text-brand-navy-900">{session.usherName}</p>
            </div>
          </div>
          <button
            onClick={confirmSignOut}
            aria-label="Sign out"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-brand-ice-200 bg-white text-brand-navy-700/60 shadow-sm transition hover:border-red-200 hover:text-red-600 active:scale-95"
          >
            <SignOutIcon className="h-5 w-5" />
          </button>
        </div>

        {/* ---------------- event details (own section, owner request 2026-09-11:
             pulled out of the usher-identity header into its own container) ---------------- */}
        <div className="mt-3.5 rounded-xl bg-blue-50 px-4 py-2.5">
          <p className="truncate text-sm font-semibold text-brand-navy-900">{session.eventName}</p>
          {session.gateId && <p className="truncate text-xs text-brand-navy-700/50">Gate: {session.gateId}</p>}
        </div>

        {/* ---------------- status pills ---------------- */}
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              session.scanningEnabled ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${session.scanningEnabled ? 'bg-emerald-500' : 'bg-red-500'}`} />
            {session.scanningEnabled ? 'Scanner ready' : 'Scanning disabled'}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-ice-100 px-3 py-1 text-xs font-semibold text-brand-navy-800">
            {session.acceptedCount} Admitted
          </span>
        </div>

        {disabledBanner && (
          <div className="mt-4 rounded-xl bg-red-600 p-4 text-center text-lg font-bold text-white">
            EVENT NOT OPEN — SCANNING DISABLED
          </div>
        )}

        {cameraError && (
          <p className="mt-4 text-center text-sm font-medium text-red-600">{cameraError}</p>
        )}

        {/* ---------------- camera card: idle / active ---------------- */}
        <div className="relative mt-4">
          {/* ---------------- scan result — floating popup ABOVE the camera,
              never below it and never shifting this layout (owner request,
              2026-09-11). Absolutely positioned relative to this wrapper and
              anchored to its own top edge (bottom-full), so it can never
              push the camera card or the Stop Scanner button down — it's
              fully out of flow. Auto-closes after 3s via showResult()'s
              timer; the thin bar at the bottom is a pure CSS animation
              (scan-toast-bar, globals.css) timed to the same 3000ms, so
              there's a visual countdown with no numbers. Keyed by
              resultSeq so the entrance + bar animations restart cleanly
              even when consecutive scans produce the identical result. */}
          {result && (
            <div
              key={resultSeq}
              className={`scan-toast-in absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-2xl text-white shadow-brand ${
                result.kind === 'granted' ? 'bg-emerald-600' : result.kind === 'denied' ? 'bg-red-600' : 'bg-amber-600'
              }`}
            >
              <div className="p-4 text-center">
                {result.kind === 'granted' && (
                  <>
                    <p className="text-2xl font-black tracking-wide">ACCESS GRANTED ✓</p>
                    {result.tag && <p className="mt-1.5 text-base font-semibold">{result.tag}</p>}
                    {result.serial && <p className="mt-1 font-mono text-sm opacity-90">No. {result.serial}</p>}
                    {typeof result.usageCount === 'number' && result.usageLimit !== 1 && (
                      <p className="mt-1 text-xs opacity-80">
                        Uses: {result.usageCount}{result.usageLimit === null ? ' (unlimited)' : ` of ${result.usageLimit}`}
                      </p>
                    )}
                    <p className="mt-1 text-sm opacity-80">Welcome the guest in</p>
                  </>
                )}
                {result.kind === 'denied' && (
                  <>
                    <p className="text-2xl font-black tracking-wide">{result.code === 'ALREADY_USED' ? 'ALREADY USED ✗' : 'DENIED ✗'}</p>
                    <p className="mt-1.5 text-sm">{result.message}</p>
                    {result.tag && <p className="mt-1 text-sm font-semibold">{result.tag}</p>}
                    {result.serial && <p className="mt-1 font-mono text-sm">No. {result.serial}</p>}
                    {result.firstUsedAt && (
                      <p className="mt-1 text-xs opacity-80">
                        First scanned: {new Date(result.firstUsedAt).toLocaleTimeString()} — ask an admin to allow rescan if this was a network error.
                      </p>
                    )}
                  </>
                )}
                {result.kind === 'error' && <p className="text-lg font-bold">{result.message}</p>}
              </div>
              {/* Countdown line — shrinks to nothing over exactly 3s, no digits. */}
              <div className="h-1 w-full bg-white/25">
                <div className="scan-toast-bar h-full w-full bg-white/80" />
              </div>
            </div>
          )}

          <div className="relative overflow-hidden rounded-2xl bg-brand-navy-900 shadow-brand" style={{ minHeight: '260px' }}>
            {/* ALWAYS mounted (never display:none/unmounted): qr-scanner
                attaches its live decode loop directly to this <video>
                element, so it must already exist in the DOM — visible,
                normal display — before start() runs. muted+playsInline are
                required for iOS Safari to actually play the stream inline
                instead of forcing fullscreen (which breaks frame capture).
                The idle/active covers below are opaque SIBLING overlays
                stacked on top of it, never a toggle of its own
                display/visibility — a zero-size or hidden video was one of
                the candidate causes of "camera looks on but nothing scans"
                and this keeps that risk at zero. */}
            <video
              id="qr-video"
              ref={videoRef}
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover"
            />

            {!scanning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-brand-teal-400">
                  <ScanFrameIcon className="h-6 w-6" />
                </span>
                <div>
                  <p className="text-lg font-semibold text-white">Ready to scan</p>
                  <p className="mt-1 text-sm text-brand-ice-200/60">Scan the access code on the invitation</p>
                </div>
                <button
                  onClick={() => startScanner()}
                  disabled={starting || processing}
                  className="mt-1 rounded-full bg-brand-teal-400 px-8 py-3 text-base font-semibold text-brand-navy-950 shadow-brand transition active:scale-95 disabled:opacity-50"
                >
                  {starting ? 'Starting camera…' : 'Start Scanner'}
                </button>
              </div>
            )}

            {scanning && (
              // Purely decorative targeting frame drawn on top of the live
              // video — pointer-events-none, no effect on the decode loop,
              // which reads frames directly off the <video> element itself.
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative h-[60%] w-[60%] max-h-64 max-w-64">
                  <span className="absolute left-0 top-0 h-8 w-8 rounded-tl-lg border-l-2 border-t-2 border-brand-teal-400" />
                  <span className="absolute right-0 top-0 h-8 w-8 rounded-tr-lg border-r-2 border-t-2 border-brand-teal-400" />
                  <span className="absolute bottom-0 left-0 h-8 w-8 rounded-bl-lg border-b-2 border-l-2 border-brand-teal-400" />
                  <span className="absolute bottom-0 right-0 h-8 w-8 rounded-br-lg border-b-2 border-r-2 border-brand-teal-400" />
                </div>
              </div>
            )}
          </div>

          {scanning && (
            <button
              onClick={stopScanner}
              className="mt-3 w-full rounded-xl border border-brand-ice-200 bg-white py-2.5 text-sm font-medium text-brand-navy-700 shadow-sm transition hover:bg-brand-ice-50 active:scale-[0.99]"
            >
              Stop Scanner
            </button>
          )}
        </div>

        {scanning && (
          <p role="status" data-decoder-ready={decoderReady} className="mt-2 text-center text-sm text-brand-navy-700/55">
            {processing ? 'Processing invitation…' : decoderReady ? '' : 'Camera live — waiting for the QR decoder…'}
          </p>
        )}

        {/* Manual entry: always available, including while the camera runs —
            deliberately secondary in weight (muted border, smaller type)
            but never hidden behind a toggle. Type the serial number printed
            on the card — with or without the hyphen, any case; the server
            matches both stored serial shapes. */}
        <div className="mt-6 text-left">
          <label htmlFor="manual-entry" className="text-xs font-medium text-brand-navy-700/50">
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
            <div className="mt-1.5 flex gap-2">
              <input
                name="manual"
                id="manual-entry"
                placeholder="e.g. ISWED00042"
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-brand-ice-200 bg-white px-3 py-2 font-mono text-sm uppercase tracking-wide text-brand-navy-900 focus:border-brand-blue-400 focus:outline-none"
              />
              <button
                type="submit"
                className="shrink-0 rounded-lg border border-brand-ice-200 bg-white px-4 py-2 text-sm font-semibold text-brand-navy-700 shadow-sm transition hover:bg-brand-ice-50"
              >
                Check
              </button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
