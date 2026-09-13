'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { adminFetch, adminJson } from '@/lib/client/api';

type Geometry = {
  ok: boolean;
  canvasWidth: number;
  canvasHeight: number;
  qr: { x: number; y: number; size: number };
  hasOverride: boolean;
  message?: string;
};

// Displayed editor width, in CSS px — the master artwork (often 1000px+)
// is always scaled DOWN to this for the live preview. scale = this /
// canvasWidth converts canvas-pixel coordinates <-> on-screen coordinates.
const DISPLAY_WIDTH = 360;
const ARROW_STEP = 2; // canvas px per arrow-key press
const ARROW_STEP_FAST = 20; // canvas px per arrow-key press while holding Shift

/**
 * Manual QR position editor (owner request, 2026-09-13): drag the QR
 * anywhere on a live preview of the template, or nudge it with the
 * keyboard arrows, then Save. The "ACCESS CODE" label and serial are
 * always drawn as a fixed offset BELOW the QR (see geometry.ts) — moving
 * the QR moves that whole group together automatically, so only one
 * handle is needed here.
 */
export default function ModifyTemplatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [canvasHeight, setCanvasHeight] = useState(0);
  const [size, setSize] = useState(0);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [hasOverride, setHasOverride] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  const scale = canvasWidth > 0 ? DISPLAY_WIDTH / canvasWidth : 0;
  const displayHeight = canvasHeight * scale;

  const clamp = useCallback(
    (next: { x: number; y: number }) => ({
      x: Math.min(Math.max(next.x, 0), Math.max(0, canvasWidth - size)),
      y: Math.min(Math.max(next.y, 0), Math.max(0, canvasHeight - size)),
    }),
    [canvasWidth, canvasHeight, size]
  );

  useEffect(() => {
    let artworkObjectUrl: string | null = null;
    (async () => {
      setLoading(true);
      setError('');
      const [geoRes, artRes] = await Promise.all([
        adminFetch(`/api/admin/templates/${id}/geometry`),
        adminFetch(`/api/admin/templates/${id}/artwork`),
      ]);
      if (!geoRes.ok || !artRes.ok) {
        setError('Could not load this template. Go back and try again.');
        setLoading(false);
        return;
      }
      const geo = (await geoRes.json()) as Geometry;
      const blob = await artRes.blob();
      artworkObjectUrl = URL.createObjectURL(blob);
      setArtworkUrl(artworkObjectUrl);
      setCanvasWidth(geo.canvasWidth);
      setCanvasHeight(geo.canvasHeight);
      setSize(geo.qr.size);
      setPos({ x: geo.qr.x, y: geo.qr.y });
      setHasOverride(geo.hasOverride);
      setLoading(false);
      // Focus the handle immediately so keyboard arrows work with no extra click.
      boxRef.current?.focus();
    })();
    return () => { if (artworkObjectUrl) URL.revokeObjectURL(artworkObjectUrl); };
  }, [id]);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    boxRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || scale === 0) return;
    const dx = (e.clientX - d.startX) / scale;
    const dy = (e.clientY - d.startY) / scale;
    setPos(clamp({ x: d.startPosX + dx, y: d.startPosY + dy }));
  }

  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
    boxRef.current?.releasePointerCapture(e.pointerId);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const step = e.shiftKey ? ARROW_STEP_FAST : ARROW_STEP;
    let dx = 0, dy = 0;
    if (e.key === 'ArrowUp') dy = -step;
    else if (e.key === 'ArrowDown') dy = step;
    else if (e.key === 'ArrowLeft') dx = -step;
    else if (e.key === 'ArrowRight') dx = step;
    else return;
    e.preventDefault();
    setPos((prev) => clamp({ x: prev.x + dx, y: prev.y + dy }));
  }

  async function save() {
    setSaving(true);
    setMsg('');
    setError('');
    const r = await adminJson<Geometry>(`/api/admin/templates/${id}/geometry`, {
      method: 'PATCH',
      body: JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }),
    }).catch(() => null);
    setSaving(false);
    if (!r?.ok) { setError(r?.message ?? 'Could not save the new position.'); return; }
    setHasOverride(true);
    setMsg('Position saved — every card generated from this template now uses this spot.');
  }

  async function resetToDefault() {
    setSaving(true);
    setMsg('');
    setError('');
    const r = await adminJson<Geometry>(`/api/admin/templates/${id}/geometry`, {
      method: 'PATCH',
      body: JSON.stringify({ x: null, y: null }),
    }).catch(() => null);
    setSaving(false);
    if (!r?.ok) { setError(r?.message ?? 'Could not reset the position.'); return; }
    setPos({ x: r.qr.x, y: r.qr.y });
    setHasOverride(false);
    setMsg('Reset to the default position.');
  }

  if (loading) return <p className="text-brand-navy-700/60">Loading template…</p>;
  if (error && !artworkUrl) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-red-700">{error}</p>
        <button onClick={() => router.push('/admin/templates')} className="text-sm underline text-brand-navy-700">
          Back to templates
        </button>
      </div>
    );
  }

  const boxSize = size * scale;

  return (
    <div className="max-w-xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-brand-navy-900">Modify QR position</h2>
        <button onClick={() => router.push('/admin/templates')} className="text-sm text-brand-navy-700 underline">
          Back to templates
        </button>
      </div>

      <p className="text-sm text-brand-navy-700/70">
        Drag the box onto the live preview, or use the arrow keys (hold Shift to move faster) to nudge it.
        The &quot;ACCESS CODE&quot; label and serial number always sit just below the QR, so they move together with it automatically.
      </p>

      <div
        className="relative overflow-hidden rounded-xl border border-brand-ice-200 bg-brand-navy-900 shadow-brand"
        style={{ width: DISPLAY_WIDTH, height: displayHeight }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL background, next/image can't optimize it */}
        {artworkUrl && <img src={artworkUrl} alt="Template artwork" className="absolute inset-0 h-full w-full object-cover" draggable={false} />}
        <div
          ref={boxRef}
          role="slider"
          aria-label="QR code position — drag or use arrow keys"
          aria-valuetext={`x ${Math.round(pos.x)}, y ${Math.round(pos.y)}`}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          className="absolute cursor-grab touch-none rounded-md border-2 border-dashed border-brand-teal-400 bg-brand-teal-400/15 outline-none focus-visible:ring-2 focus-visible:ring-brand-teal-400 active:cursor-grabbing"
          style={{ left: pos.x * scale, top: pos.y * scale, width: boxSize, height: boxSize }}
        >
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-[10px] font-semibold uppercase tracking-wide text-brand-teal-100">
            QR
          </span>
        </div>
      </div>

      <p className="text-xs text-brand-navy-700/50">
        Position: x {Math.round(pos.x)}, y {Math.round(pos.y)} (of {canvasWidth}×{canvasHeight}px)
        {hasOverride ? ' — custom' : ' — default'}
      </p>

      {msg && <p className="text-sm text-emerald-700">{msg}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="h-10 rounded-lg bg-brand-blue-500 px-6 font-medium text-white hover:bg-brand-blue-600 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save position'}
        </button>
        {hasOverride && (
          <button
            onClick={resetToDefault}
            disabled={saving}
            className="h-10 rounded-lg border border-brand-ice-200 px-6 font-medium text-brand-navy-700 hover:bg-brand-ice-50 disabled:opacity-50"
          >
            Reset to default
          </button>
        )}
      </div>
    </div>
  );
}
